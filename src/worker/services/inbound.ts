import {
  bodySnippet,
  buildThreadKey,
  normalizeMessageId,
  referenceIds,
} from "../lib/mime-lite";
import { newId, now, parseJson, textToHtml } from "../lib/util";
import type { Env, MailboxRow, NormalizedInbound, RuleRow, TemplateRow } from "../types";
import { sendCfReply } from "../adapters/outbound/cf-reply";
import { outboundMessageFrom } from "../adapters/outbound";
import { evaluateStaticGuards } from "./guard";
import {
  matchesRule,
  parseRuleAction,
  parseRuleGuards,
  parseRuleMatch,
  type RuleAction,
  type RuleGuards,
} from "./rule-engine";
import { claimReply, releaseReplyClaim } from "./throttle";
import { isBusinessHoursAllowed } from "./schedule";
import { renderTemplate, quoteBody } from "./template";
import { buildReplyThread } from "../lib/reply-thread";
import { loadSettings } from "./settings";
import { aiClassify, aiPolish } from "./ai";
import { enqueueJob, type SendJobPayload } from "./jobs";
import { getTemplate, getOutboundChannel, listRules, listTemplates } from "./store";
import { insertOutboundMessage, recordSendLog, updateInboundStatus } from "./message-log";
import { recordAttempt, refreshInboundStatus, updateAttempt } from "./attempts";
import { deliverOutbound } from "./delivery";

export interface PipelineOptions {
  cfMessage?: ForwardableEmailMessage;
}

export interface PipelineResult {
  status: "replied" | "queued" | "skipped" | "failed" | "duplicate";
  inboundMessageId: string;
  ruleId?: string;
  ruleIds?: string[];
  reason?: string;
}

interface RuleCandidate {
  rule: RuleRow;
  template: TemplateRow;
  action: RuleAction;
  guards: RuleGuards;
}

interface BlockedRule {
  rule: RuleRow;
  code: string;
  reason: string;
}

export async function processInbound(
  env: Env,
  inbound: NormalizedInbound,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const timestamp = now();
  const refs = referenceIds(inbound.headers.references);
  const inReplyTo = normalizeMessageId(inbound.headers["in-reply-to"]);
  const threadKey = buildThreadKey({
    references: inbound.headers.references,
    inReplyTo,
    messageId: inbound.messageId,
    subject: inbound.subject,
  });
  const inboundId = newId("msg");

  const insert = await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (id, mailbox_id, channel_id, direction, message_id,
     in_reply_to, references_json, thread_key, from_addr, from_name, to_json, subject,
     snippet, raw_size, parse_mode, r2_key, rule_id, status, error, received_at, created_at)
     VALUES (?, ?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'received', NULL, ?, ?)`,
  )
    .bind(
      inboundId,
      inbound.mailboxId,
      inbound.channelId,
      inbound.messageId,
      inReplyTo || null,
      JSON.stringify(refs),
      threadKey,
      inbound.from,
      inbound.fromName || null,
      JSON.stringify(inbound.to),
      inbound.subject,
      inbound.snippet || bodySnippet(inbound.text),
      inbound.rawSize,
      inbound.parseMode,
      inbound.r2Key,
      inbound.receivedAt,
      timestamp,
    )
    .run();

  if (!insert.meta.changes) {
    return { status: "duplicate", inboundMessageId: inboundId, reason: "重复邮件" };
  }

  const mailbox = await env.DB.prepare("SELECT * FROM mailboxes WHERE id = ?")
    .bind(inbound.mailboxId)
    .first<MailboxRow>();
  if (!mailbox || !mailbox.enabled) {
    return await skip(env, inboundId, "mailbox_disabled", "邮箱不存在或已禁用");
  }

  if (await isSuppressed(env, mailbox.id, inbound.from)) {
    return await skip(env, inboundId, "suppressed", "发件人在抑制名单中");
  }

  const staticGuard = evaluateStaticGuards({
    mailboxAddress: mailbox.address,
    from: inbound.from,
    headers: inbound.headers,
    text: inbound.text,
    referencesCount: refs.length,
    contentType: inbound.headers["content-type"] || "",
  });
  if (!staticGuard.allowed) {
    return await skip(env, inboundId, staticGuard.code || "guard", staticGuard.reason || "防循环守卫拒绝");
  }

  const settings = await loadSettings(env);
  const context = {
    from: inbound.from,
    fromName: inbound.fromName,
    to: inbound.to,
    cc: inbound.cc,
    subject: inbound.subject,
    body: inbound.text,
    headers: inbound.headers,
    hasAttachment: inbound.hasAttachment,
  };

  // A CF native reply can only be sent once per EmailMessage event, so that
  // channel deliberately stops at the first matching rule.
  const channel = await getOutboundChannel(env, mailbox.id);
  const singleReply = channel?.kind === "cf_reply";

  const rules = await listRules(env, mailbox.id);
  const candidates: RuleCandidate[] = [];
  let outsideHours = false;
  let blocked: BlockedRule | null = null;

  for (const rule of rules) {
    if (!matchesRule(parseRuleMatch(rule.match_json), context)) continue;
    const guards = parseRuleGuards(rule.guards_json);
    const action = parseRuleAction(rule.action_json);

    if (singleReply) {
      if (!action) {
        blocked = { rule, code: "invalid_action", reason: "规则动作无效" };
      } else if (!isBusinessHoursAllowed(guards)) {
        blocked = { rule, code: "outside_business_hours", reason: "当前不在规则生效时间内" };
      } else {
        const template = await getTemplate(env, action.templateId);
        if (!template) {
          blocked = { rule, code: "template_missing", reason: "规则绑定的模板不存在" };
        } else {
          candidates.push({ rule, template, action, guards });
        }
      }
      break;
    }

    if (!isBusinessHoursAllowed(guards)) {
      outsideHours = true;
      continue;
    }
    if (!action) continue;
    const template = await getTemplate(env, action.templateId);
    if (!template) continue;
    candidates.push({ rule, template, action, guards });
  }

  if (
    !candidates.length &&
    !blocked &&
    !outsideHours &&
    settings.ai.enabled &&
    settings.ai.classifyFallback
  ) {
    const templates = await listTemplates(env);
    if (templates.length) {
      const aiPick = await aiClassify(
        env,
        settings,
        mailbox.id,
        {
          fromName: inbound.fromName,
          from: inbound.from,
          subject: inbound.subject,
          body: inbound.text,
          templateSubject: "",
          templateText: "",
        },
        templates.map((template) => ({
          id: template.id,
          name: template.name,
          subject: template.subject_tpl,
        })),
      );
      const picked = aiPick && aiPick.confidence >= 0.6
        ? templates.find((template) => template.id === aiPick.templateId)
        : null;
      if (picked) {
        const action = parseRuleAction(JSON.stringify({ type: "reply", templateId: picked.id }));
        if (action) {
          candidates.push({
            rule: {
              id: "ai-classify",
              name: "AI 分类",
              priority: 999,
              enabled: 1,
              match_json: "{}",
              guards_json: "{}",
              action_json: JSON.stringify({ type: "reply", templateId: picked.id }),
              created_at: timestamp,
              updated_at: timestamp,
            },
            template: picked,
            action,
            guards: {},
          });
        }
      }
    }
  }

  if (blocked) {
    const reason = `${blocked.code}: ${blocked.reason}`;
    await recordAttempt(env, {
      inboundMessageId: inboundId,
      mailboxId: mailbox.id,
      ruleId: blocked.rule.id,
      ruleName: blocked.rule.name,
      status: "skipped",
      reason,
    });
    return await finalize(env, inboundId, [blocked.rule.id], reason);
  }

  if (!candidates.length) {
    if (outsideHours) {
      return await skip(env, inboundId, "outside_business_hours", "当前不在规则生效时间内");
    }
    return await skip(env, inboundId, "no_match", "没有匹配的规则或模板");
  }

  if (!channel || channel.status !== "active") {
    return await failCandidates(
      env,
      inboundId,
      mailbox.id,
      candidates,
      "no_outbound_channel",
      "该邮箱没有可用的发信通道",
    );
  }

  const attemptedRuleIds: string[] = [];

  for (const candidate of candidates) {
    attemptedRuleIds.push(candidate.rule.id);
    const attemptBase = {
      inboundMessageId: inboundId,
      mailboxId: mailbox.id,
      ruleId: candidate.rule.id,
      ruleName: candidate.rule.name,
    };

    if (channel.kind === "cf_reply" && candidate.action.replyAsNew === true) {
      await recordAttempt(env, {
        ...attemptBase,
        status: "skipped",
        reason:
          "cf_reply_requires_thread: Cloudflare 原生回复无法发送新会话，请改用 SMTP / Resend / Mailgun",
      });
      continue;
    }

    const actionAi = candidate.action.ai || { mode: "off" as const };
    let template = candidate.template;
    if (actionAi.mode === "classify" && settings.ai.enabled) {
      const templates = await listTemplates(env);
      const aiPick = await aiClassify(
        env,
        settings,
        mailbox.id,
        {
          fromName: inbound.fromName,
          from: inbound.from,
          subject: inbound.subject,
          body: inbound.text,
          templateSubject: template.subject_tpl,
          templateText: template.text_tpl,
        },
        templates.map((item) => ({ id: item.id, name: item.name, subject: item.subject_tpl })),
      );
      if (aiPick && aiPick.confidence >= 0.5) {
        template = templates.find((item) => item.id === aiPick.templateId) || template;
      }
    }

    const throttle = await claimReply(env, {
      mailboxId: mailbox.id,
      ruleId: candidate.rule.id,
      threadKey,
      senderKey: inbound.from,
      cooldownHours: candidate.guards.cooldownHours ?? 24,
      maxPerThread: candidate.guards.maxPerThread ?? 1,
      globalDailyLimit: settings.globalDailyLimit,
    });
    if (!throttle.allowed) {
      await recordAttempt(env, {
        ...attemptBase,
        status: "skipped",
        reason: `${throttle.code || "throttled"}: ${throttle.reason || "触发限流"}`,
      });
      continue;
    }

    const variables: Record<string, string> = {
      sender_name: inbound.fromName || inbound.from,
      sender_email: inbound.from,
      subject: inbound.subject,
      original_subject: inbound.subject,
      date: new Date(timestamp).toISOString(),
      mailbox: mailbox.address,
      mailbox_name: mailbox.display_name || mailbox.address,
      quoted_body: quoteBody(inbound.text),
      ai_text: "",
    };

    if (actionAi.mode === "polish" && settings.ai.enabled) {
      const base = renderTemplate(template, variables);
      const polished = await aiPolish(env, settings, mailbox.id, {
        fromName: inbound.fromName,
        from: inbound.from,
        subject: inbound.subject,
        body: inbound.text,
        templateSubject: base.subject,
        templateText: base.text,
      });
      if (polished) variables.ai_text = polished;
    }

    const rendered = renderTemplate(template, variables);
    if (variables.ai_text && !template.text_tpl.includes("{{ai_text}}")) {
      rendered.text = `${rendered.text}\n\n${variables.ai_text}`.trim();
      rendered.html = `${rendered.html}\n<p>${textToHtml(variables.ai_text)}</p>`;
    }

    const thread = buildReplyThread({
      replyAsNew: candidate.action.replyAsNew === true,
      inboundMessageId: inbound.messageId,
      inboundReferences: inbound.headers.references,
      inboundSubject: inbound.subject,
      templateSubject: rendered.subject,
    });
    const subject = thread.subject;
    const references = thread.references;
    const replyHeaders: Record<string, string> = {
      "Auto-Submitted": "auto-replied",
      "X-Auto-Response-Suppress": "All",
      "X-Auto-Reply": "auto-reply-email",
    };
    if (thread.inReplyTo) {
      replyHeaders["In-Reply-To"] = thread.inReplyTo;
    }
    if (references.length) replyHeaders["References"] = references.join(" ");

    const replyInput = {
      to: inbound.from,
      subject,
      text: rendered.text,
      html: rendered.html,
      headers: replyHeaders,
    };

    const delaySeconds = candidate.action.delaySeconds || 0;

    if (channel.kind === "cf_reply") {
      if (!options.cfMessage) {
        await releaseReplyClaim(env, mailbox.id, candidate.rule.id, threadKey);
        await recordAttempt(env, {
          ...attemptBase,
          status: "failed",
          reason: "cf_reply_requires_cf_routing: cf_reply 只能用于 Cloudflare Email Routing 入站邮件",
        });
        return await finalize(env, inboundId, attemptedRuleIds);
      }
      if (delaySeconds > 0) {
        await releaseReplyClaim(env, mailbox.id, candidate.rule.id, threadKey);
        await recordAttempt(env, {
          ...attemptBase,
          status: "failed",
          reason: "cf_reply_no_delay: Cloudflare 原生回复不支持延迟发送",
        });
        return await finalize(env, inboundId, attemptedRuleIds);
      }

      const cfMessage = outboundMessageFrom(mailbox, channel, replyInput);
      const cfSender = inbound.to[0] || mailbox.address;
      cfMessage.from.email = cfSender;
      try {
        await sendCfReply(options.cfMessage, cfMessage);
        const outboundId = await insertOutboundMessage(env, {
          mailboxId: mailbox.id,
          channelId: channel.id,
          inReplyTo: thread.inReplyTo || inbound.messageId,
          references,
          threadKey,
          from: cfSender,
          fromName: channel.from_name || mailbox.display_name || cfSender,
          to: inbound.from,
          subject,
          text: rendered.text,
          html: rendered.html,
          ruleId: candidate.rule.id,
          status: "sent",
        });
        await recordSendLog(env, outboundId, "cf_reply", null, "cloudflare email routing reply");
        await recordAttempt(env, {
          ...attemptBase,
          status: "sent",
          outboundMessageId: outboundId,
        });
        return await finalize(env, inboundId, attemptedRuleIds);
      } catch (error) {
        await releaseReplyClaim(env, mailbox.id, candidate.rule.id, threadKey);
        await recordAttempt(env, {
          ...attemptBase,
          status: "failed",
          reason: `cf_reply_failed: Cloudflare 原生回复失败: ${String(
            error instanceof Error ? error.message : error,
          )}`,
        });
        return await finalize(env, inboundId, attemptedRuleIds);
      }
    }

    const outbound = outboundMessageFrom(mailbox, channel, replyInput);

    if (delaySeconds > 0) {
      const attemptId = await recordAttempt(env, {
        ...attemptBase,
        status: "queued",
        reason: `等待 ${delaySeconds} 秒后通过 ${channel.kind} 发送`,
      });
      const payload: SendJobPayload = {
        mailboxId: mailbox.id,
        channelId: channel.id,
        inboundMessageId: inboundId,
        ruleId: candidate.rule.id,
        threadKey,
        attemptId,
        message: outbound,
      };
      await enqueueJob(env, {
        kind: "send",
        dedupeKey: `send:${inboundId}:${candidate.rule.id}`,
        payload,
        runAt: timestamp + delaySeconds * 1000,
      });
      continue;
    }

    const attemptId = await recordAttempt(env, {
      ...attemptBase,
      status: "pending",
      reason: `立即通过 ${channel.kind} 发送`,
    });
    const payload: SendJobPayload = {
      mailboxId: mailbox.id,
      channelId: channel.id,
      inboundMessageId: inboundId,
      ruleId: candidate.rule.id,
      threadKey,
      attemptId,
      message: outbound,
    };

    try {
      const result = await deliverOutbound(env, {
        mailbox,
        channel,
        inboundMessageId: inboundId,
        ruleId: candidate.rule.id,
        threadKey,
        message: outbound,
      });
      await updateAttempt(env, attemptId, {
        status: "sent",
        reason: null,
        outboundMessageId: result.outboundId,
      });
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      console.warn("immediate send failed, queued for retry", {
        mailbox: mailbox.address,
        channel: channel.kind,
        rule: candidate.rule.name,
        message,
      });
      await updateAttempt(env, attemptId, {
        status: "queued",
        reason: `立即发送失败，已入队重试: ${message}`,
      });
      await enqueueJob(env, {
        kind: "send",
        dedupeKey: `send:${inboundId}:${candidate.rule.id}`,
        payload,
        runAt: timestamp,
      });
    }
  }

  return await finalize(env, inboundId, attemptedRuleIds);
}

async function finalize(
  env: Env,
  inboundId: string,
  ruleIds: string[],
  fallbackReason?: string,
): Promise<PipelineResult> {
  const aggregate = await refreshInboundStatus(env, inboundId);
  return {
    status: aggregate?.status || "skipped",
    inboundMessageId: inboundId,
    ruleId: ruleIds[0],
    ruleIds,
    reason: aggregate?.error || fallbackReason,
  };
}

async function failCandidates(
  env: Env,
  inboundId: string,
  mailboxId: string,
  candidates: RuleCandidate[],
  code: string,
  reason: string,
): Promise<PipelineResult> {
  const ruleIds: string[] = [];
  for (const candidate of candidates) {
    ruleIds.push(candidate.rule.id);
    await recordAttempt(env, {
      inboundMessageId: inboundId,
      mailboxId,
      ruleId: candidate.rule.id,
      ruleName: candidate.rule.name,
      status: "failed",
      reason: `${code}: ${reason}`,
    });
  }
  const aggregate = await refreshInboundStatus(env, inboundId);
  const detail = `${code}: ${reason}`;
  if (!aggregate) {
    await updateInboundStatus(env, inboundId, "failed", detail);
    return { status: "failed", inboundMessageId: inboundId, ruleIds, reason: detail };
  }
  return {
    status: aggregate.status,
    inboundMessageId: inboundId,
    ruleId: ruleIds[0],
    ruleIds,
    reason: aggregate.error || detail,
  };
}

async function skip(
  env: Env,
  inboundId: string,
  code: string,
  reason: string,
): Promise<PipelineResult> {
  await updateInboundStatus(env, inboundId, "skipped", `${code}: ${reason}`);
  return { status: "skipped", inboundMessageId: inboundId, reason: `${code}: ${reason}` };
}

async function isSuppressed(env: Env, mailboxId: string, from: string): Promise<boolean> {
  const rows = await env.DB.prepare(
    `SELECT address FROM suppressions
     WHERE (mailbox_id = ? OR mailbox_id IS NULL)
       AND (expires_at IS NULL OR expires_at > ?)`,
  )
    .bind(mailboxId, now())
    .all<{ address: string }>();
  const normalized = from.toLowerCase();
  return (rows.results || []).some((row) => {
    const rule = row.address.toLowerCase().trim();
    if (!rule) return false;
    if (rule.startsWith("@")) return normalized.endsWith(rule);
    return normalized === rule || normalized.endsWith(`@${rule}`);
  });
}

export function parseGuards(json: string): Record<string, unknown> {
  return parseJson(json, {});
}
