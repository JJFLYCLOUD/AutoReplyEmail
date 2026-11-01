import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env, MessageRow } from "../types";
import {
  deleteMailbox,
  findMailboxForRecipient,
  getMailbox,
  getOutboundChannel,
  getOutboundChannelById,
  getRule,
  getRuleMailboxIds,
  getTemplate,
  listInboundChannels,
  listMailboxes,
  listOutboundChannels,
  listTemplates,
  logAudit,
  publicChannel,
  replaceRuleMailboxes,
  saveMailbox,
} from "../services/store";
import { requireAdmin, handleLogin, handleLogout, getAuthConfig, isAuthConfigured } from "../services/auth";
import { ruleInputSchema } from "../services/rule-engine";
import { matchesRule, parseRuleMatch, parseRuleGuards } from "../services/rule-engine";
import { evaluateStaticGuards, mergeGuardOptions } from "../services/guard";
import { renderTemplate } from "../services/template";
import { loadSettings, toPublicSettings, updateSettings } from "../services/settings";
import { getMessage, insertOutboundMessage, listMessages, recordSendLog } from "../services/message-log";
import { drainJobs, listJobs, retryJob } from "../services/jobs";
import { outboundMessageFrom, sendViaChannel } from "../adapters/outbound";
import { testImapConnection } from "../adapters/inbound/imap";
import { testPop3Connection } from "../adapters/inbound/pop3";
import { ImapClient } from "../lib/imap-client";
import { newId, now, parseJson, startOfUtcDay } from "../lib/util";
import { aiPolish } from "../services/ai";
import { processInbound } from "../services/inbound";
import { pollDueAccounts } from "../services/poller";
import { bodySnippet } from "../lib/mime-lite";
import type { NormalizedInbound } from "../types";

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const inboundSchema = z.object({
  kind: z.enum(["cf_routing", "imap", "pop3"]),
  host: z.string().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  tls: z.boolean().optional(),
  startTls: z.boolean().optional(),
  username: z.string().max(255).optional(),
  password: z.string().max(500).optional(),
  folder: z.string().max(100).optional(),
  pollIntervalSec: z.number().int().min(60).max(3600).optional(),
  initialSync: z.enum(["skip", "recent"]).optional(),
  fetchLimit: z.number().int().min(1).max(10).optional(),
});

const outboundSchema = z.object({
  kind: z.enum(["cf_reply", "smtp", "resend", "mailgun"]),
  host: z.string().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional(),
  username: z.string().max(255).optional(),
  password: z.string().max(500).optional(),
  apiKey: z.string().max(1000).optional(),
  domain: z.string().max(255).optional(),
  fromName: z.string().max(120).optional(),
  replyTo: z.string().max(255).optional(),
  dailyLimit: z.number().int().min(1).max(100000).optional(),
});

const mailboxSchema = z.object({
  address: z.string().regex(emailRegex, "邮箱地址格式不正确"),
  displayName: z.string().max(120).optional(),
  matchMode: z.enum(["exact", "domain"]).optional(),
  timezone: z.string().max(64).optional(),
  enabled: z.boolean().optional(),
  inbound: inboundSchema.nullish(),
  outbound: outboundSchema.nullish(),
});

const templateSchema = z.object({
  name: z.string().min(1).max(120),
  locale: z.string().max(20).optional(),
  subjectTpl: z.string().min(1).max(900),
  textTpl: z.string().min(1).max(20000),
  htmlTpl: z.string().max(50000).nullish(),
});

const settingsSchema = z.object({
  ai: z
    .object({
      enabled: z.boolean().optional(),
      provider: z.enum(["workers-ai", "external"]).optional(),
      workersAiModel: z.string().max(200).optional(),
      externalBaseUrl: z.string().max(500).optional(),
      externalModel: z.string().max(200).optional(),
      dailyRequestLimit: z.number().int().min(0).max(100000).optional(),
      classifyFallback: z.boolean().optional(),
      externalApiKey: z.string().max(2000).nullish(),
    })
    .optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  globalDailyLimit: z.number().int().min(1).max(100000).optional(),
  timezone: z.string().max(64).optional(),
});

const suppressionSchema = z.object({
  mailboxId: z.string().nullish(),
  address: z.string().min(1).max(255),
  reason: z.string().max(500).optional(),
  expiresAt: z.number().int().nullish(),
});

function forbidden(c: any): Response {
  return c.json({ error: "forbidden", message: "需要管理员权限" }, 403);
}

function invalid(c: any, issues: unknown): Response {
  return c.json({ error: "invalid_request", issues }, 400);
}

const mailboxIdsSchema = z.array(z.string().min(1)).min(1).max(100);

function parseMailboxIds(body: Record<string, unknown>): string[] | null {
  const raw =
    body.mailboxIds ??
    (typeof body.mailboxId === "string" ? [body.mailboxId] : undefined);
  const parsed = mailboxIdsSchema.safeParse(raw);
  return parsed.success ? [...new Set(parsed.data)] : null;
}

async function mailboxesExist(env: Env, mailboxIds: string[]): Promise<boolean> {
  const unique = [...new Set(mailboxIds)];
  if (!unique.length) return false;
  const placeholders = unique.map(() => "?").join(",");
  const result = await env.DB.prepare(
    `SELECT id FROM mailboxes WHERE id IN (${placeholders})`,
  )
    .bind(...unique)
    .all<{ id: string }>();
  return (result.results || []).length === unique.length;
}

async function audit(
  env: Env,
  actor: string,
  action: string,
  targetType: string,
  targetId: string,
  meta?: unknown,
): Promise<void> {
  try {
    await logAudit(env, actor, action, targetType, targetId, meta);
  } catch (error) {
    console.error("audit failed", String(error));
  }
}

export function createApi(): Hono<AppEnv> {
  const api = new Hono<AppEnv>();

  api.post("/auth/login", handleLogin);
  api.post("/auth/logout", handleLogout);

  api.get("/me", async (c) => {
    const user = c.get("user");
    const settings = await loadSettings(c.env);
    const auth = getAuthConfig(c.env);
    return c.json({
      user,
      settings: toPublicSettings(settings),
      auth: {
        mode: "password",
        username: auth.username,
        sessionHours: auth.sessionHours,
        configured: isAuthConfigured(c.env),
      },
    });
  });

  api.get("/stats", async (c) => {
    const dayStart = startOfUtcDay();
    const [inbound, replied, skipped, failed, queued, pendingJobs, mailboxes, ai, recent] =
      await Promise.all([
        c.env.DB.prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE direction = 'in' AND received_at >= ?",
        )
          .bind(dayStart)
          .first<{ count: number }>(),
        c.env.DB.prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE direction = 'out' AND status = 'sent' AND received_at >= ?",
        )
          .bind(dayStart)
          .first<{ count: number }>(),
        c.env.DB.prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE direction = 'in' AND status = 'skipped' AND received_at >= ?",
        )
          .bind(dayStart)
          .first<{ count: number }>(),
        c.env.DB.prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE direction = 'in' AND status = 'failed' AND received_at >= ?",
        )
          .bind(dayStart)
          .first<{ count: number }>(),
        c.env.DB.prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE direction = 'in' AND status = 'queued' AND received_at >= ?",
        )
          .bind(dayStart)
          .first<{ count: number }>(),
        c.env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('pending','running')")
          .first<{ count: number }>(),
        c.env.DB.prepare("SELECT COUNT(*) AS count FROM mailboxes").first<{ count: number }>(),
        c.env.DB.prepare("SELECT SUM(requests) AS requests FROM ai_usage WHERE day = ?")
          .bind(new Date().toISOString().slice(0, 10))
          .first<{ requests: number | null }>(),
        c.env.DB.prepare("SELECT * FROM messages ORDER BY received_at DESC LIMIT 10")
          .all<MessageRow>(),
      ]);

    return c.json({
      today: {
        inbound: inbound?.count || 0,
        replied: replied?.count || 0,
        skipped: skipped?.count || 0,
        failed: failed?.count || 0,
        queued: queued?.count || 0,
      },
      pendingJobs: pendingJobs?.count || 0,
      mailboxes: mailboxes?.count || 0,
      aiRequests: ai?.requests || 0,
      recent: recent.results || [],
    });
  });

  api.get("/mailboxes", async (c) => {
    const mailboxes = await listMailboxes(c.env);
    const items = await Promise.all(
      mailboxes.map(async (mailbox) => {
        const [inbound, outbound, rules] = await Promise.all([
          listInboundChannels(c.env, mailbox.id),
          listOutboundChannels(c.env, mailbox.id),
          c.env.DB.prepare(
            "SELECT COUNT(*) AS count FROM rule_mailboxes WHERE mailbox_id = ?",
          )
            .bind(mailbox.id)
            .first<{ count: number }>(),
        ]);
        return {
          ...mailbox,
          enabled: Boolean(mailbox.enabled),
          inbound: inbound.map(publicChannel),
          outbound: outbound.map(publicChannel),
          ruleCount: rules?.count || 0,
        };
      }),
    );
    return c.json({ items });
  });

  api.post("/mailboxes", async (c) => {
    if (!requireAdmin(c)) return forbidden(c);
    const parsed = mailboxSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c, parsed.error.issues);
    const mailbox = await saveMailbox(c.env, parsed.data);
    await audit(c.env, c.get("user").email, "mailbox.create", "mailbox", mailbox.id, {
      address: mailbox.address,
    });
    return c.json({ mailbox }, 201);
  });

  api.patch("/mailboxes/:id", async (c) => {
    if (!requireAdmin(c)) return forbidden(c);
    const existing = await getMailbox(c.env, c.req.param("id"));
    if (!existing) return c.json({ error: "not_found" }, 404);
    const parsed = mailboxSchema.partial().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c, parsed.error.issues);
    const input = parsed.data;
    const mailbox = await saveMailbox(
      c.env,
      {
        address: input.address ?? existing.address,
        displayName: input.displayName ?? existing.display_name ?? undefined,
        matchMode: (input.matchMode as "exact" | "domain" | undefined) ?? (existing.match_mode as "exact" | "domain"),
        timezone: input.timezone ?? existing.timezone,
        enabled: input.enabled ?? Boolean(existing.enabled),
        inbound: input.inbound ?? undefined,
        outbound: input.outbound ?? undefined,
      },
      existing.id,
    );
    await audit(c.env, c.get("user").email, "mailbox.update", "mailbox", mailbox.id);
    return c.json({ mailbox });
  });

  api.delete("/mailboxes/:id", async (c) => {
    if (!requireAdmin(c)) return forbidden(c);
    const existing = await getMailbox(c.env, c.req.param("id"));
    if (!existing) return c.json({ error: "not_found" }, 404);
    await deleteMailbox(c.env, existing.id);
    await audit(c.env, c.get("user").email, "mailbox.delete", "mailbox", existing.id);
    return c.json({ ok: true });
  });

  api.post("/mailboxes/:id/test-inbound", async (c) => {
    if (!requireAdmin(c)) return forbidden(c);
    const channels = await listInboundChannels(c.env, c.req.param("id"));
    const imap = channels.find((channel) => channel.kind === "imap");
    const pop3 = channels.find((channel) => channel.kind === "pop3");
    const channel = imap || pop3;
    if (!channel) return c.json({ error: "no_inbound_channel" }, 400);
    try {
      const info =
        channel.kind === "pop3"
          ? await testPop3Connection(c.env, channel)
          : await testImapConnection(c.env, channel);
      await audit(c.env, c.get("user").email, "channel.test_inbound", "inbound_channel", channel.id);
      return c.json({ ok: true, kind: channel.kind, ...info });
    } catch (error) {
      return c.json({ ok: false, error: String(error instanceof Error ? error.message : error) }, 400);
    }
  });

  api.post("/mailboxes/:id/test-outbound", async (c) => {
    if (!requireAdmin(c)) return forbidden(c);
    const mailbox = await getMailbox(c.env, c.req.param("id"));
    if (!mailbox) return c.json({ error: "not_found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { to?: string; channelId?: string };
    const to = (body.to || "").trim();
    if (!emailRegex.test(to)) return c.json({ error: "invalid_recipient" }, 400);

    let channel = body.channelId ? await getOutboundChannelById(c.env, body.channelId) : null;
    if (!channel) channel = await getOutboundChannel(c.env, mailbox.id);
    if (!channel || channel.kind === "cf_reply") {
      return c.json({ error: "no_outbound_channel", message: "请为该邮箱配置 SMTP 或 API 发信通道" }, 400);
    }

    const message = outboundMessageFrom(mailbox, channel, {
      to,
      subject: `[Auto Reply] 测试邮件 ${new Date().toISOString()}`,
      text: "这是一封来自 Auto Reply 管理后台的测试邮件。",
      html: "<p>这是一封来自 <strong>Auto Reply</strong> 管理后台的测试邮件。</p>",
      headers: { "Auto-Submitted": "auto-generated", "X-Auto-Reply": "auto-reply-email" },
    });
    try {
      const result = await sendViaChannel(c.env, channel, message);
      await audit(c.env, c.get("user").email, "channel.test_outbound", "outbound_channel", channel.id, { to });
      return c.json({ ok: true, result });
    } catch (error) {
      return c.json({ ok: false, error: String(error instanceof Error ? error.message : error) }, 400);
    }
  });

  api.get("/templates", async (c) => {
    return c.json({ items: await listTemplates(c.env) });
  });

  api.post("/templates", async (c) => {
    if (!requireAdmin(c)) return forbidden(c);
    const parsed = templateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c, parsed.error.issues);
    const id = newId("tpl");
    const timestamp = now();
    await c.env.DB.prepare(
      `INSERT INTO templates (id, name, locale, subject_tpl, text_tpl, html_tpl,
       created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        parsed.data.name,
        parsed.data.locale || "zh-CN",
        parsed.data.subjectTpl,
        parsed.data.textTpl,
        parsed.data.htmlTpl || null,
        timestamp,
        timestamp,
      )
      .run();
    await audit(c.env, c.get("user").email, "template.create", "template", id);
    return c.json({ id }, 201);
  });

  api.patch("/templates/:id", async (c) => {
    if (!requireAdmin(c)) return forbidden(c);
    const existing = await getTemplate(c.env, c.req.param("id"));
    if (!existing) return c.json({ error: "not_found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    await c.env.DB.prepare(
      `UPDATE templates SET name = ?, locale = ?, subject_tpl = ?, text_tpl = ?, html_tpl = ?,
       updated_at = ? WHERE id = ?`,
    )
      .bind(
        typeof body.name === "string" ? body.name : existing.name,
        typeof body.locale === "string" ? body.locale : existing.locale,
        typeof body.subjectTpl === "string" ? body.subjectTpl : existing.subject_tpl,
        typeof body.textTpl === "string" ? body.textTpl : existing.text_tpl,
        typeof body.htmlTpl === "string" ? body.htmlTpl : existing.html_tpl,
        now(),
        existing.id,
      )
      .run();
    await audit(c.env, c.get("user").email, "template.update", "template", existing.id);
    return c.json({ ok: true });
  });

  api.delete("/templates/:id", async (c) => {
    if (!requireAdmin(c)) return forbidden(c);
    const existing = await getTemplate(c.env, c.req.param("id"));
    if (!existing) return c.json({ error: "not_found" }, 404);
    await c.env.DB.prepare("DELETE FROM templates WHERE id = ?").bind(existing.id).run();
    await audit(c.env, c.get("user").email, "template.delete", "template", existing.id);
    return c.json({ ok: true });
  });

  api.post("/templates/:id/preview", async (c) => {
    const template = await getTemplate(c.env, c.req.param("id"));
    if (!template) return c.json({ error: "not_found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      vars?: Record<string, string>;
      template?: { subjectTpl?: string; textTpl?: string; htmlTpl?: string };
    };
    const content = body.template
      ? {
          subject_tpl: body.template.subjectTpl || template.subject_tpl,
          text_tpl: body.template.textTpl || template.text_tpl,
          html_tpl: body.template.htmlTpl ?? template.html_tpl,
        }
      : template;
    const rendered = renderTemplate(content, {
      sender_name: "张三",
      sender_email: "sender@example.com",
      subject: "产品报价咨询",
      original_subject: "产品报价咨询",
      date: new Date().toISOString(),
      mailbox: "support@example.com",
      mailbox_name: "Support",
      quoted_body: "> 你好，我想了解产品报价。",
      ai_text: "感谢您的咨询，我们会在 1 个工作日内回复。",
      ...(body.vars || {}),
    });
    return c.json(rendered);
  });

  api.get("/rules", async (c) => {
    const mailboxId = c.req.query("mailboxId");
    const result = mailboxId
      ? await c.env.DB.prepare(
          `SELECT r.* FROM rules r
           JOIN rule_mailboxes rm ON rm.rule_id = r.id
           WHERE rm.mailbox_id = ?
           ORDER BY r.priority ASC, r.created_at ASC`,
        )
          .bind(mailboxId)
          .all()
      : await c.env.DB.prepare(
          "SELECT * FROM rules ORDER BY priority ASC, created_at ASC LIMIT 200",
        ).all();
    const items = await Promise.all(
      (result.results || []).map(async (rule) => ({
        ...rule,
        mailboxIds: await getRuleMailboxIds(c.env, String((rule as { id: string }).id)),
      })),
    );
    return c.json({ items });
  });

  api.post("/rules", async (c) => {
    if (!requireAdmin(c)) return forbidden(c);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const mailboxIds = parseMailboxIds(body);
    if (!mailboxIds) return c.json({ error: "mailbox_required" }, 400);
    if (!(await mailboxesExist(c.env, mailboxIds))) {
      return c.json({ error: "mailbox_not_found" }, 404);
    }
    const parsed = ruleInputSchema.safeParse(body);
    if (!parsed.success) return invalid(c, parsed.error.issues);
    const id = newId("rule");
    const timestamp = now();
    await c.env.DB.prepare(
      `INSERT INTO rules (id, name, priority, enabled, match_json, guards_json,
       action_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        parsed.data.name,
        parsed.data.priority,
        parsed.data.enabled ? 1 : 0,
        JSON.stringify(parsed.data.match),
        JSON.stringify(parsed.data.guards),
        JSON.stringify(parsed.data.action),
        timestamp,
        timestamp,
      )
      .run();
    await replaceRuleMailboxes(c.env, id, mailboxIds);
    await audit(c.env, c.get("user").email, "rule.create", "rule", id);
    return c.json({ id }, 201);
  });

  api.patch("/rules/:id", async (c) => {
    if (!requireAdmin(c)) return forbidden(c);
    const existing = await getRule(c.env, c.req.param("id"));
    if (!existing) return c.json({ error: "not_found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const merged = {
      name: typeof body.name === "string" ? body.name : existing.name,
      priority: typeof body.priority === "number" ? body.priority : existing.priority,
      enabled: typeof body.enabled === "boolean" ? body.enabled : Boolean(existing.enabled),
      match: body.match ?? parseJson(existing.match_json, {}),
      guards: body.guards ?? parseJson(existing.guards_json, {}),
      action: body.action ?? parseJson(existing.action_json, {}),
    };
    const parsed = ruleInputSchema.safeParse(merged);
    if (!parsed.success) return invalid(c, parsed.error.issues);

    if ("mailboxIds" in body || typeof body.mailboxId === "string") {
      const mailboxIds = parseMailboxIds(body);
      if (!mailboxIds) return c.json({ error: "mailbox_required" }, 400);
      if (!(await mailboxesExist(c.env, mailboxIds))) {
        return c.json({ error: "mailbox_not_found" }, 404);
      }
      await replaceRuleMailboxes(c.env, existing.id, mailboxIds);
    }

    const effectiveMailboxIds = await getRuleMailboxIds(c.env, existing.id);
    if (parsed.data.enabled && effectiveMailboxIds.length === 0) {
      return c.json(
        { error: "mailbox_required", message: "启用规则前请先绑定至少一个邮箱" },
        400,
      );
    }

    await c.env.DB.prepare(
      `UPDATE rules SET name = ?, priority = ?, enabled = ?, match_json = ?, guards_json = ?,
       action_json = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(
        parsed.data.name,
        parsed.data.priority,
        parsed.data.enabled ? 1 : 0,
        JSON.stringify(parsed.data.match),
        JSON.stringify(parsed.data.guards),
        JSON.stringify(parsed.data.action),
        now(),
        existing.id,
      )
      .run();
    await audit(c.env, c.get("user").email, "rule.update", "rule", existing.id);
    return c.json({ ok: true });
  });

  api.delete("/rules/:id", async (c) => {
    if (!requireAdmin(c)) return forbidden(c);
    const existing = await getRule(c.env, c.req.param("id"));
    if (!existing) return c.json({ error: "not_found" }, 404);
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM rule_mailboxes WHERE rule_id = ?").bind(existing.id),
      c.env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(existing.id),
    ]);
    await audit(c.env, c.get("user").email, "rule.delete", "rule", existing.id);
    return c.json({ ok: true });
  });

  api.post("/rules/:id/test", async (c) => {
    const rule = await getRule(c.env, c.req.param("id"));
    if (!rule) return c.json({ error: "not_found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { messageId?: string };
    if (!body.messageId) return c.json({ error: "message_required" }, 400);
    const message = await getMessage(c.env, body.messageId);
    if (!message) return c.json({ error: "message_not_found" }, 404);
    const ctx = {
      from: message.from_addr || "",
      fromName: message.from_name || "",
      to: parseJson<string[]>(message.to_json, []),
      cc: [],
      subject: message.subject || "",
      body: message.body_text || message.snippet || "",
      headers: {} as Record<string, string>,
      hasAttachment: false,
    };
    const matched = matchesRule(parseRuleMatch(rule.match_json), ctx);
    const guard = evaluateStaticGuards(
      {
        mailboxAddress: "",
        from: ctx.from,
        headers: ctx.headers,
        text: ctx.body,
        referencesCount: parseJson<string[]>(message.references_json, []).length,
        contentType: "",
      },
      mergeGuardOptions(parseRuleGuards(rule.guards_json)),
    );
    return c.json({ matched, guard });
  });

  api.get("/messages", async (c) => {
    const items = await listMessages(c.env, {
      mailboxId: c.req.query("mailboxId") || undefined,
      direction: c.req.query("direction") || undefined,
      status: c.req.query("status") || undefined,
      search: c.req.query("q") || undefined,
      limit: Number(c.req.query("limit") || 50),
      offset: Number(c.req.query("offset") || 0),
    });
    return c.json({ items });
  });

  api.get("/messages/:id", async (c) => {
    const message = await getMessage(c.env, c.req.param("id"));
    if (!message) return c.json({ error: "not_found" }, 404);
    let raw: string | null = null;
    if (message.r2_key) {
      try {
        const object = await c.env.RAW.get(message.r2_key);
        if (object) raw = (await object.text()).slice(0, 200_000);
      } catch (error) {
        console.error("failed to read raw message", String(error));
      }
    }
    return c.json({ message, raw });
  });

  api.get("/messages/:id/raw", async (c) => {
    const message = await getMessage(c.env, c.req.param("id"));
    if (!message?.r2_key) return c.json({ error: "not_found" }, 404);
    const object = await c.env.RAW.get(message.r2_key);
    if (!object) return c.json({ error: "not_found" }, 404);
    return new Response(object.body, {
      headers: {
        "content-type": "message/rfc822; charset=utf-8",
        "content-disposition": `attachment; filename="${message.id}.eml"`,
      },
    });
  });

  api.post("/messages/:id/resend", async (c) => {
    if (!requireAdmin(c)) return forbidden(c);
    const message = await getMessage(c.env, c.req.param("id"));
    if (!message || message.direction !== "out") {
      return c.json({ error: "not_outbound_message" }, 400);
    }
    const mailbox = await getMailbox(c.env, message.mailbox_id);
    if (!mailbox) return c.json({ error: "mailbox_not_found" }, 404);
    let channel = message.channel_id
      ? await getOutboundChannelById(c.env, message.channel_id)
      : null;
    if (!channel) channel = await getOutboundChannel(c.env, mailbox.id);
    if (!channel || channel.kind === "cf_reply") {
      return c.json({ error: "no_outbound_channel" }, 400);
    }
    const to = parseJson<string[]>(message.to_json, [])[0];
    if (!to) return c.json({ error: "missing_recipient" }, 400);
    const outbound = outboundMessageFrom(mailbox, channel, {
      to,
      subject: message.subject || "Re:",
      text: message.body_text || message.snippet || "",
      html: message.body_html || "",
      headers: {
        "Auto-Submitted": "auto-replied",
        "X-Auto-Response-Suppress": "All",
        ...(message.in_reply_to ? { "In-Reply-To": message.in_reply_to } : {}),
        ...(parseJson<string[]>(message.references_json, []).length
          ? { References: parseJson<string[]>(message.references_json, []).join(" ") }
          : {}),
      },
    });
    try {
      const result = await sendViaChannel(c.env, channel, outbound);
      const outboundId = await insertOutboundMessage(c.env, {
        mailboxId: mailbox.id,
        channelId: channel.id,
        inReplyTo: message.in_reply_to,
        references: parseJson<string[]>(message.references_json, []),
        threadKey: message.thread_key || "",
        from: mailbox.address,
        fromName: channel.from_name || mailbox.display_name || mailbox.address,
        to,
        subject: message.subject || "Re:",
        text: outbound.text,
        html: outbound.html,
        ruleId: message.rule_id,
        status: "sent",
      });
      await recordSendLog(c.env, outboundId, channel.kind, result.providerMessageId || null, result.response || null);
      await audit(c.env, c.get("user").email, "message.resend", "message", message.id);
      return c.json({ ok: true, id: outboundId });
    } catch (error) {
      return c.json({ ok: false, error: String(error instanceof Error ? error.message : error) }, 400);
    }
  });

  api.delete("/messages/:id", async (c) => {
    if (!requireAdmin(c)) return forbidden(c);
    const message = await getMessage(c.env, c.req.param("id"));
    if (!message) return c.json({ error: "not_found" }, 404);
    if (message.r2_key) {
      try {
        await c.env.RAW.delete(message.r2_key);
      } catch {
        // ignore
      }
    }
    await c.env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(message.id).run();
    await audit(c.env, c.get("user").email, "message.delete", "message", message.id);
    return c.json({ ok: true });
  });

  api.get("/jobs", async (c) => {
    return c.json({ items: await listJobs(c.env, Number(c.req.query("limit") || 100)) });
  });

  api.post("/jobs/drain", async (c) => {
    if (!requireAdmin(c)) return forbidden(c);
    const processed = await drainJobs(c.env, 5);
    return c.json({ ok: true, processed });
  });

  api.post("/jobs/:id/retry", async (c) => {
    if (!requireAdmin(c)) return forbidden(c);
    await retryJob(c.env, c.req.param("id"));
    await audit(c.env, c.get("user").email, "job.retry", "job", c.req.param("id"));
    return c.json({ ok: true });
  });

  api.get("/suppressions", async (c) => {
    const mailboxId = c.req.query("mailboxId");
    const result = mailboxId
      ? await c.env.DB.prepare(
          "SELECT * FROM suppressions WHERE mailbox_id = ? OR mailbox_id IS NULL ORDER BY created_at DESC",
        )
          .bind(mailboxId)
          .all()
      : await c.env.DB.prepare("SELECT * FROM suppressions ORDER BY created_at DESC LIMIT 500").all();
    return c.json({ items: result.results || [] });
  });

  api.post("/suppressions", async (c) => {
    if (!requireAdmin(c)) return forbidden(c);
    const parsed = suppressionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c, parsed.error.issues);
    const id = newId("sup");
    await c.env.DB.prepare(
      `INSERT INTO suppressions (id, mailbox_id, address, reason, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(mailbox_id, address) DO UPDATE SET reason = excluded.reason,
         expires_at = excluded.expires_at`,
    )
      .bind(
        id,
        parsed.data.mailboxId || null,
        parsed.data.address.toLowerCase(),
        parsed.data.reason || null,
        parsed.data.expiresAt || null,
        now(),
      )
      .run();
    await audit(c.env, c.get("user").email, "suppression.create", "suppression", id);
    return c.json({ id }, 201);
  });

  api.delete("/suppressions/:id", async (c) => {
    if (!requireAdmin(c)) return forbidden(c);
    await c.env.DB.prepare("DELETE FROM suppressions WHERE id = ?").bind(c.req.param("id")).run();
    await audit(c.env, c.get("user").email, "suppression.delete", "suppression", c.req.param("id"));
    return c.json({ ok: true });
  });

  api.get("/audit", async (c) => {
    const result = await c.env.DB.prepare(
      "SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?",
    )
      .bind(Math.min(Number(c.req.query("limit") || 100), 500))
      .all();
    return c.json({ items: result.results || [] });
  });

  api.get("/settings", async (c) => {
    return c.json({ settings: toPublicSettings(await loadSettings(c.env)) });
  });

  api.put("/settings", async (c) => {
    if (!requireAdmin(c)) return forbidden(c);
    const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c, parsed.error.issues);
    const settings = await updateSettings(c.env, parsed.data);
    await audit(c.env, c.get("user").email, "settings.update", "settings", "app");
    return c.json({ settings: toPublicSettings(settings) });
  });

  api.post("/settings/test-ai", async (c) => {
    if (!requireAdmin(c)) return forbidden(c);
    const settings = await loadSettings(c.env);
    if (!settings.ai.enabled) return c.json({ error: "ai_disabled" }, 400);
    const text = await aiPolish(c.env, settings, "test", {
      fromName: "测试用户",
      from: "test@example.com",
      subject: "测试 AI 回复",
      body: "你好，请确认 AI 回复功能是否正常。",
      templateSubject: "Re: {{subject}}",
      templateText: "您好，感谢您的来信，我们会尽快回复。",
    });
    if (!text) return c.json({ ok: false, error: "AI 请求失败或超出额度" }, 400);
    return c.json({ ok: true, text });
  });

  api.post("/dev/inbound", async (c) => {
    if (c.env.ENVIRONMENT === "production") {
      return c.json({ error: "not_found" }, 404);
    }
    const parsed = z
      .object({
        to: z.string().regex(emailRegex),
        from: z.string().regex(emailRegex),
        fromName: z.string().max(120).optional(),
        subject: z.string().max(900).default(""),
        text: z.string().max(20000).default(""),
        html: z.string().max(50000).optional(),
        headers: z.record(z.string(), z.string()).optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c, parsed.error.issues);

    const mailbox = await findMailboxForRecipient(c.env, parsed.data.to);
    if (!mailbox) return c.json({ error: "mailbox_not_found" }, 404);

    const timestamp = now();
    const headers: Record<string, string> = {
      from: parsed.data.from,
      to: parsed.data.to,
      subject: parsed.data.subject,
      "message-id": `<dev-${newId("mid")}@${mailbox.domain}>`,
      "content-type": "text/plain; charset=utf-8",
      ...(parsed.data.headers || {}),
    };
    const inbound: NormalizedInbound = {
      mailboxId: mailbox.id,
      channelId: null,
      messageId: headers["message-id"],
      from: parsed.data.from,
      fromName: parsed.data.fromName || "",
      to: [parsed.data.to],
      cc: [],
      subject: parsed.data.subject,
      headers,
      text: parsed.data.text,
      html: parsed.data.html || "",
      snippet: bodySnippet(parsed.data.text),
      rawSize: parsed.data.text.length,
      parseMode: "full",
      r2Key: null,
      receivedAt: timestamp,
      hasAttachment: false,
    };
    const result = await processInbound(c.env, inbound);
    return c.json({ result, mailbox: mailbox.address });
  });

  api.post("/dev/imap-fetch", async (c) => {
    if (c.env.ENVIRONMENT === "production") {
      return c.json({ error: "not_found" }, 404);
    }
    const parsed = z
      .object({
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535).default(993),
        tls: z.boolean().default(true),
        startTls: z.boolean().default(true),
        username: z.string().min(1),
        password: z.string().min(1),
        folder: z.string().default("INBOX"),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c, parsed.error.issues);

    const client = await ImapClient.connect({
      host: parsed.data.host,
      port: parsed.data.port,
      tls: parsed.data.tls,
      startTls: parsed.data.startTls,
      username: parsed.data.username,
      password: parsed.data.password,
      timeoutMs: 15000,
    });
    try {
      const info = await client.select(parsed.data.folder);
      const uids = await client.searchUids(1);
      const first = uids.length ? await client.fetchMessage(uids[0]) : null;
      return c.json({
        ok: true,
        info,
        uids,
        message: first
          ? {
              uid: first.uid,
              size: first.size,
              header: first.header.slice(0, 2000),
              body: first.body.slice(0, 2000),
            }
          : null,
      });
    } finally {
      await client.logout();
    }
  });

  api.post("/dev/poll", async (c) => {
    if (c.env.ENVIRONMENT === "production") {
      return c.json({ error: "not_found" }, 404);
    }
    await pollDueAccounts(c.env, Number(c.req.query("limit") || 5));
    const [channels, messages, jobs] = await Promise.all([
      c.env.DB.prepare(
        `SELECT id, mailbox_id, kind, cursor_uidvalidity, cursor_uid, last_checked_at,
         next_poll_at, last_error FROM inbound_channels ORDER BY updated_at DESC LIMIT 10`,
      ).all(),
      listMessages(c.env, { limit: 10 }),
      listJobs(c.env, 10),
    ]);
    return c.json({
      ok: true,
      channels: channels.results || [],
      messages,
      jobs,
    });
  });

  return api;
}
