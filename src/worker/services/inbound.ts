import {
  bodySnippet,
  buildThreadKey,
  normalizeMessageId,
  referenceIds,
} from "../lib/mime-lite";
import { newId, now, parseJson, textToHtml } from "../lib/util";
import type { Env, MailboxRow, NormalizedInbound, RuleRow, TemplateRow } from "../types";
import { sendCfReply } from "../adapters/outbound/cf-reply";
import {
  outboundMessageFrom,
} from "../adapters/outbound";
import { evaluateStaticGuards } from "./guard";
import { matchesRule, parseRuleAction, parseRuleGuards, parseRuleMatch } from "./rule-engine";
import { claimReply, releaseReplyClaim } from "./throttle";
import { isBusinessHoursAllowed } from "./schedule";
import { renderTemplate, normalizeReplySubject, quoteBody } from "./template";
import { loadSettings } from "./settings";
import { aiClassify, aiPolish } from "./ai";
import { enqueueJob, type SendJobPayload } from "./jobs";
import { getTemplate, getOutboundChannel, listRules, listTemplates } from "./store";
import {
  insertOutboundMessage,
  recordSendLog,
  updateInboundStatus,
} from "./message-log";
import { deliverOutbound } from "./delivery";

export interface PipelineOptions {
  cfMessage?: ForwardableEmailMessage;
}

export interface PipelineResult {
  status: "replied" | "queued" | "skipped" | "failed" | "duplicate";
  inboundMessageId: string;
  ruleId?: string;
  reason?: string;
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

  const rules = await listRules(env, mailbox.id);
  let matched: { rule: RuleRow; template: TemplateRow } | null = null;
  let outsideHours = false;

  for (const rule of rules) {
    const match = parseRuleMatch(rule.match_json);
    if (!matchesRule(match, context)) continue;
    const guards = parseRuleGuards(rule.guards_json);
    if (!isBusinessHoursAllowed(guards)) {
      outsideHours = true;
      continue;
    }
    const action = parseRuleAction(rule.action_json);
    if (!action) continue;
    const template = await getTemplate(env, action.templateId);
    if (!template) continue;
    matched = { rule, template };
    break;
  }

  if (!matched && outsideHours) {
    return await skip(env, inboundId, "outside_business_hours", "当前不在规则生效时间内");
  }

  if (!matched && settings.ai.enabled && settings.ai.classifyFallback) {
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
        matched = {
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
        };
      }
    }
  }

  if (!matched) {
    return await skip(env, inboundId, "no_match", "没有匹配的规则或模板");
  }

  const action = parseRuleAction(matched.rule.action_json);
  if (!action) {
    return await skip(env, inboundId, "invalid_action", "规则动作无效");
  }
  const guards = parseRuleGuards(matched.rule.guards_json);
  const actionAi = action.ai || { mode: "off" as const };

  let template = matched.template;
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
    ruleId: matched.rule.id,
    threadKey,
    senderKey: inbound.from,
    cooldownHours: guards.cooldownHours ?? 24,
    maxPerThread: guards.maxPerThread ?? 1,
    globalDailyLimit: settings.globalDailyLimit,
  });
  if (!throttle.allowed) {
    return await skip(env, inboundId, throttle.code || "throttled", throttle.reason || "触发限流");
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

  const subject = normalizeReplySubject(rendered.subject || inbound.subject);
  const references = refs
    .concat(normalizeMessageId(inbound.messageId) ? [normalizeMessageId(inbound.messageId)] : [])
    .slice(-99);
  const replyHeaders: Record<string, string> = {
    "Auto-Submitted": "auto-replied",
    "X-Auto-Response-Suppress": "All",
    "X-Auto-Reply": "auto-reply-email",
  };
  if (inReplyTo || inbound.messageId) {
    replyHeaders["In-Reply-To"] = inReplyTo || normalizeMessageId(inbound.messageId);
  }
  if (references.length) replyHeaders["References"] = references.join(" ");

  const replyInput = {
    to: inbound.from,
    subject,
    text: rendered.text,
    html: rendered.html,
    headers: replyHeaders,
  };

  const delaySeconds = action.delaySeconds || 0;
  const channel = await getOutboundChannel(env, mailbox.id);

  if (!channel || channel.status !== "active") {
    await releaseReplyClaim(env, mailbox.id, threadKey);
    return await fail(
      env,
      inboundId,
      "no_outbound_channel",
      "该邮箱没有可用的发信通道",
    );
  }

  if (channel.kind === "cf_reply") {
    if (!options.cfMessage) {
      await releaseReplyClaim(env, mailbox.id, threadKey);
      return await fail(
        env,
        inboundId,
        "cf_reply_requires_cf_routing",
        "cf_reply 只能用于 Cloudflare Email Routing 入站邮件",
      );
    }
    if (delaySeconds > 0) {
      await releaseReplyClaim(env, mailbox.id, threadKey);
      return await fail(
        env,
        inboundId,
        "cf_reply_no_delay",
        "Cloudflare 原生回复不支持延迟发送",
      );
    }

    const cfMessage = outboundMessageFrom(mailbox, channel, replyInput);
    const cfSender = inbound.to[0] || mailbox.address;
    cfMessage.from.email = cfSender;
    try {
      await sendCfReply(options.cfMessage, cfMessage);
      const outboundId = await insertOutboundMessage(env, {
        mailboxId: mailbox.id,
        channelId: channel.id,
        inReplyTo: inReplyTo || inbound.messageId,
        references,
        threadKey,
        from: cfSender,
        fromName: channel.from_name || mailbox.display_name || cfSender,
        to: inbound.from,
        subject,
        text: rendered.text,
        html: rendered.html,
        ruleId: matched.rule.id,
        status: "sent",
      });
      await recordSendLog(env, outboundId, "cf_reply", null, "cloudflare email routing reply");
      await updateInboundStatus(env, inboundId, "replied");
      return { status: "replied", inboundMessageId: inboundId, ruleId: matched.rule.id };
    } catch (error) {
      await releaseReplyClaim(env, mailbox.id, threadKey);
      return await fail(
        env,
        inboundId,
        "cf_reply_failed",
        `Cloudflare 原生回复失败: ${String(error instanceof Error ? error.message : error)}`,
      );
    }
  }

  const outbound = outboundMessageFrom(mailbox, channel, replyInput);
  const payload: SendJobPayload = {
    mailboxId: mailbox.id,
    channelId: channel.id,
    inboundMessageId: inboundId,
    ruleId: matched.rule.id,
    threadKey,
    message: outbound,
  };

  if (delaySeconds > 0) {
    await enqueueJob(env, {
      kind: "send",
      dedupeKey: `send:${inboundId}:${matched.rule.id}`,
      payload,
      runAt: timestamp + delaySeconds * 1000,
    });
    await updateInboundStatus(
      env,
      inboundId,
      "queued",
      `等待 ${delaySeconds} 秒后通过 ${channel.kind} 发送`,
    );
    return { status: "queued", inboundMessageId: inboundId, ruleId: matched.rule.id };
  }

  try {
    await deliverOutbound(env, {
      mailbox,
      channel,
      inboundMessageId: inboundId,
      ruleId: matched.rule.id,
      threadKey,
      message: outbound,
    });
    return { status: "replied", inboundMessageId: inboundId, ruleId: matched.rule.id };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    console.warn("immediate send failed, queued for retry", {
      mailbox: mailbox.address,
      channel: channel.kind,
      message,
    });
    await enqueueJob(env, {
      kind: "send",
      dedupeKey: `send:${inboundId}:${matched.rule.id}`,
      payload,
      runAt: timestamp,
    });
    await updateInboundStatus(
      env,
      inboundId,
      "queued",
      `立即发送失败，已入队重试: ${message}`,
    );
    return { status: "queued", inboundMessageId: inboundId, ruleId: matched.rule.id };
  }
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

async function fail(
  env: Env,
  inboundId: string,
  code: string,
  reason: string,
): Promise<PipelineResult> {
  await updateInboundStatus(env, inboundId, "failed", `${code}: ${reason}`);
  return { status: "failed", inboundMessageId: inboundId, reason: `${code}: ${reason}` };
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
