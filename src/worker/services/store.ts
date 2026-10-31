import { decryptSecret, encryptSecret, type EncryptedSecret } from "../lib/crypto";
import { addressDomain, newId, now, parseJson } from "../lib/util";
import type {
  Env,
  InboundChannelRow,
  MailboxRow,
  OutboundChannelRow,
  RuleRow,
  TemplateRow,
} from "../types";

export interface InboundInput {
  kind: "cf_routing" | "imap" | "pop3";
  host?: string;
  port?: number;
  tls?: boolean;
  startTls?: boolean;
  username?: string;
  password?: string;
  folder?: string;
  pollIntervalSec?: number;
  initialSync?: "skip" | "recent";
  fetchLimit?: number;
}

export interface OutboundInput {
  kind: "cf_reply" | "smtp" | "resend" | "mailgun";
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  password?: string;
  apiKey?: string;
  domain?: string;
  fromName?: string;
  replyTo?: string;
  dailyLimit?: number;
}

export interface MailboxInput {
  address: string;
  displayName?: string;
  matchMode?: "exact" | "domain";
  timezone?: string;
  enabled?: boolean;
  replyVia?: string;
  inbound?: InboundInput | null;
  outbound?: OutboundInput | null;
}

export function publicChannel(row: InboundChannelRow | OutboundChannelRow) {
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    kind: row.kind,
    config: parseJson(row.config_json, {}),
    status: row.status,
    fromName: "from_name" in row ? row.from_name : null,
    replyTo: "reply_to" in row ? row.reply_to : null,
    dailyLimit: "daily_limit" in row ? row.daily_limit : null,
    cursorUidvalidity: "cursor_uidvalidity" in row ? row.cursor_uidvalidity : null,
    cursorUid: "cursor_uid" in row ? row.cursor_uid : null,
    lastCheckedAt: "last_checked_at" in row ? row.last_checked_at : null,
    lastError: "last_error" in row ? row.last_error : null,
    hasSecret: Boolean(row.secret_ct),
  };
}

export async function findMailboxForRecipient(
  env: Env,
  recipient: string,
): Promise<MailboxRow | null> {
  const address = recipient.trim().toLowerCase();
  const exact = await env.DB.prepare("SELECT * FROM mailboxes WHERE lower(address) = ? AND enabled = 1")
    .bind(address)
    .first<MailboxRow>();
  if (exact) return exact;

  const domain = addressDomain(address);
  if (!domain) return null;

  return await env.DB.prepare(
    `SELECT * FROM mailboxes
     WHERE domain = ? AND match_mode = 'domain' AND enabled = 1
     ORDER BY created_at ASC LIMIT 1`,
  )
    .bind(domain)
    .first<MailboxRow>();
}

export async function getMailbox(env: Env, id: string): Promise<MailboxRow | null> {
  return await env.DB.prepare("SELECT * FROM mailboxes WHERE id = ?").bind(id).first<MailboxRow>();
}

export async function listMailboxes(env: Env): Promise<MailboxRow[]> {
  const result = await env.DB.prepare("SELECT * FROM mailboxes ORDER BY created_at ASC").all<MailboxRow>();
  return result.results || [];
}

export async function saveMailbox(
  env: Env,
  input: MailboxInput,
  id?: string,
): Promise<MailboxRow> {
  const timestamp = now();
  const address = input.address.trim().toLowerCase();
  const domain = addressDomain(address);
  if (!domain) throw new Error("邮箱地址无效");
  const existing = id ? await getMailbox(env, id) : null;
  const mailboxId = existing?.id || newId("mbx");

  if (existing) {
    await env.DB.prepare(
      `UPDATE mailboxes SET address = ?, display_name = ?, domain = ?, match_mode = ?,
       timezone = ?, enabled = ?, reply_via = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(
        address,
        input.displayName ?? existing.display_name,
        domain,
        input.matchMode ?? existing.match_mode,
        input.timezone ?? existing.timezone,
        input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
        input.replyVia ?? existing.reply_via,
        timestamp,
        mailboxId,
      )
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO mailboxes (id, address, display_name, domain, match_mode, timezone,
       enabled, reply_via, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        mailboxId,
        address,
        input.displayName || null,
        domain,
        input.matchMode || "exact",
        input.timezone || "UTC",
        input.enabled === false ? 0 : 1,
        input.replyVia || "auto",
        timestamp,
        timestamp,
      )
      .run();
  }

  if (input.inbound) {
    await upsertInboundChannel(env, mailboxId, input.inbound);
    await env.DB.prepare(
      "DELETE FROM inbound_channels WHERE mailbox_id = ? AND kind != ?",
    )
      .bind(mailboxId, input.inbound.kind)
      .run();
  }
  if (input.outbound) await upsertOutboundChannel(env, mailboxId, input.outbound);

  const saved = await getMailbox(env, mailboxId);
  if (!saved) throw new Error("邮箱保存失败");
  return saved;
}

export async function deleteMailbox(env: Env, id: string): Promise<void> {
  const rawRows = await env.DB.prepare(
    "SELECT r2_key FROM messages WHERE mailbox_id = ? AND r2_key IS NOT NULL",
  )
    .bind(id)
    .all<{ r2_key: string }>();
  for (const row of rawRows.results || []) {
    try {
      await env.RAW.delete(row.r2_key);
    } catch {
      // ignore
    }
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM reply_ledger WHERE mailbox_id = ?").bind(id),
    env.DB.prepare("DELETE FROM ai_usage WHERE mailbox_id = ?").bind(id),
    env.DB.prepare("DELETE FROM jobs WHERE json_extract(payload_json, '$.mailboxId') = ?").bind(id),
    env.DB.prepare(
      "DELETE FROM pop3_seen WHERE channel_id IN (SELECT id FROM inbound_channels WHERE mailbox_id = ?)",
    ).bind(id),
    env.DB.prepare(
      "DELETE FROM send_log WHERE message_id IN (SELECT id FROM messages WHERE mailbox_id = ?)",
    ).bind(id),
    env.DB.prepare("DELETE FROM messages WHERE mailbox_id = ?").bind(id),
    env.DB.prepare("DELETE FROM rules WHERE mailbox_id = ?").bind(id),
    env.DB.prepare("DELETE FROM templates WHERE mailbox_id = ?").bind(id),
    env.DB.prepare("DELETE FROM inbound_channels WHERE mailbox_id = ?").bind(id),
    env.DB.prepare("DELETE FROM outbound_channels WHERE mailbox_id = ?").bind(id),
    env.DB.prepare("DELETE FROM suppressions WHERE mailbox_id = ?").bind(id),
    env.DB.prepare("DELETE FROM mailboxes WHERE id = ?").bind(id),
  ]);
}

export async function getInboundChannel(
  env: Env,
  mailboxId: string,
  kind?: string,
): Promise<InboundChannelRow | null> {
  if (kind) {
    return await env.DB.prepare("SELECT * FROM inbound_channels WHERE mailbox_id = ? AND kind = ?")
      .bind(mailboxId, kind)
      .first<InboundChannelRow>();
  }
  return await env.DB.prepare(
    "SELECT * FROM inbound_channels WHERE mailbox_id = ? ORDER BY created_at ASC LIMIT 1",
  )
    .bind(mailboxId)
    .first<InboundChannelRow>();
}

export async function listInboundChannels(env: Env, mailboxId: string): Promise<InboundChannelRow[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM inbound_channels WHERE mailbox_id = ? ORDER BY created_at ASC",
  )
    .bind(mailboxId)
    .all<InboundChannelRow>();
  return result.results || [];
}

export async function upsertInboundChannel(
  env: Env,
  mailboxId: string,
  input: InboundInput,
): Promise<InboundChannelRow> {
  const timestamp = now();
  const existing = await getInboundChannel(env, mailboxId, input.kind);
  const config = {
    host: input.host,
    port: input.port,
    tls: input.tls,
    startTls: input.startTls ?? true,
    username: input.username,
    folder: input.folder || "INBOX",
    pollIntervalSec: input.pollIntervalSec || 300,
    initialSync: input.initialSync || "skip",
    fetchLimit: input.fetchLimit || 2,
  };
  const encrypted = input.password
    ? await encryptSecret(input.password, env.CREDENTIAL_KEY || "")
    : null;

  if (existing) {
    await env.DB.prepare(
      `UPDATE inbound_channels SET config_json = ?, secret_ct = COALESCE(?, secret_ct),
       secret_iv = COALESCE(?, secret_iv), secret_kid = COALESCE(?, secret_kid),
       status = 'active', last_error = NULL, updated_at = ? WHERE id = ?`,
    )
      .bind(
        JSON.stringify(config),
        encrypted?.ct ?? null,
        encrypted?.iv ?? null,
        encrypted?.kid ?? null,
        timestamp,
        existing.id,
      )
      .run();
    return (await env.DB.prepare("SELECT * FROM inbound_channels WHERE id = ?")
      .bind(existing.id)
      .first<InboundChannelRow>())!;
  }

  const row: InboundChannelRow = {
    id: newId("inb"),
    mailbox_id: mailboxId,
    kind: input.kind,
    config_json: JSON.stringify(config),
    secret_ct: encrypted?.ct ?? null,
    secret_iv: encrypted?.iv ?? null,
    secret_kid: encrypted?.kid ?? null,
    status: "active",
    cursor_uidvalidity: null,
    cursor_uid: null,
    last_checked_at: null,
    next_poll_at: input.kind === "imap" || input.kind === "pop3" ? timestamp : null,
    last_error: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await env.DB.prepare(
    `INSERT INTO inbound_channels (id, mailbox_id, kind, config_json, secret_ct, secret_iv,
     secret_kid, status, cursor_uidvalidity, cursor_uid, last_checked_at, next_poll_at,
     last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id,
      row.mailbox_id,
      row.kind,
      row.config_json,
      row.secret_ct,
      row.secret_iv,
      row.secret_kid,
      row.status,
      row.cursor_uidvalidity,
      row.cursor_uid,
      row.last_checked_at,
      row.next_poll_at,
      row.last_error,
      row.created_at,
      row.updated_at,
    )
    .run();
  return row;
}

export async function getOutboundChannel(
  env: Env,
  mailboxId: string,
  kind?: string,
): Promise<OutboundChannelRow | null> {
  if (kind) {
    return await env.DB.prepare("SELECT * FROM outbound_channels WHERE mailbox_id = ? AND kind = ?")
      .bind(mailboxId, kind)
      .first<OutboundChannelRow>();
  }
  return await env.DB.prepare(
    "SELECT * FROM outbound_channels WHERE mailbox_id = ? ORDER BY created_at ASC LIMIT 1",
  )
    .bind(mailboxId)
    .first<OutboundChannelRow>();
}

export async function getOutboundChannelById(env: Env, id: string): Promise<OutboundChannelRow | null> {
  return await env.DB.prepare("SELECT * FROM outbound_channels WHERE id = ?")
    .bind(id)
    .first<OutboundChannelRow>();
}

export async function listOutboundChannels(env: Env, mailboxId: string): Promise<OutboundChannelRow[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM outbound_channels WHERE mailbox_id = ? ORDER BY created_at ASC",
  )
    .bind(mailboxId)
    .all<OutboundChannelRow>();
  return result.results || [];
}

export async function upsertOutboundChannel(
  env: Env,
  mailboxId: string,
  input: OutboundInput,
): Promise<OutboundChannelRow> {
  const timestamp = now();
  const existing = await getOutboundChannel(env, mailboxId, input.kind);
  const config = {
    host: input.host,
    port: input.port,
    secure: input.secure,
    username: input.username,
    domain: input.domain,
  };
  const secretInput = input.apiKey || input.password;
  const encrypted = secretInput
    ? await encryptSecret(secretInput, env.CREDENTIAL_KEY || "")
    : null;

  if (existing) {
    await env.DB.prepare(
      `UPDATE outbound_channels SET config_json = ?, secret_ct = COALESCE(?, secret_ct),
       secret_iv = COALESCE(?, secret_iv), secret_kid = COALESCE(?, secret_kid),
       from_name = ?, reply_to = ?, daily_limit = ?, status = 'active', updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        JSON.stringify(config),
        encrypted?.ct ?? null,
        encrypted?.iv ?? null,
        encrypted?.kid ?? null,
        input.fromName ?? null,
        input.replyTo ?? null,
        input.dailyLimit ?? 100,
        timestamp,
        existing.id,
      )
      .run();
    return (await env.DB.prepare("SELECT * FROM outbound_channels WHERE id = ?")
      .bind(existing.id)
      .first<OutboundChannelRow>())!;
  }

  const row: OutboundChannelRow = {
    id: newId("out"),
    mailbox_id: mailboxId,
    kind: input.kind,
    config_json: JSON.stringify(config),
    secret_ct: encrypted?.ct ?? null,
    secret_iv: encrypted?.iv ?? null,
    secret_kid: encrypted?.kid ?? null,
    from_name: input.fromName ?? null,
    reply_to: input.replyTo ?? null,
    daily_limit: input.dailyLimit ?? 100,
    status: "active",
    created_at: timestamp,
    updated_at: timestamp,
  };
  await env.DB.prepare(
    `INSERT INTO outbound_channels (id, mailbox_id, kind, config_json, secret_ct, secret_iv,
     secret_kid, from_name, reply_to, daily_limit, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id,
      row.mailbox_id,
      row.kind,
      row.config_json,
      row.secret_ct,
      row.secret_iv,
      row.secret_kid,
      row.from_name,
      row.reply_to,
      row.daily_limit,
      row.status,
      row.created_at,
      row.updated_at,
    )
    .run();
  return row;
}

export async function decryptChannelSecret(
  env: Env,
  row: InboundChannelRow | OutboundChannelRow,
): Promise<string> {
  if (!row.secret_ct || !row.secret_iv) return "";
  return await decryptSecret(
    {
      ct: row.secret_ct,
      iv: row.secret_iv,
      kid: row.secret_kid || "v1",
    },
    env.CREDENTIAL_KEY || "",
  );
}

export async function listTemplates(env: Env, mailboxId: string): Promise<TemplateRow[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM templates WHERE mailbox_id = ? ORDER BY created_at ASC",
  )
    .bind(mailboxId)
    .all<TemplateRow>();
  return result.results || [];
}

export async function getTemplate(env: Env, id: string): Promise<TemplateRow | null> {
  return await env.DB.prepare("SELECT * FROM templates WHERE id = ?").bind(id).first<TemplateRow>();
}

export async function listRules(env: Env, mailboxId: string): Promise<RuleRow[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM rules WHERE mailbox_id = ? AND enabled = 1 ORDER BY priority ASC, created_at ASC",
  )
    .bind(mailboxId)
    .all<RuleRow>();
  return result.results || [];
}

export async function getRule(env: Env, id: string): Promise<RuleRow | null> {
  return await env.DB.prepare("SELECT * FROM rules WHERE id = ?").bind(id).first<RuleRow>();
}

export async function logAudit(
  env: Env,
  actor: string,
  action: string,
  targetType: string,
  targetId: string,
  meta?: unknown,
  ip?: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (id, actor, action, target_type, target_id, meta_json, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      newId("aud"),
      actor,
      action,
      targetType,
      targetId,
      meta ? JSON.stringify(meta) : null,
      ip || null,
      now(),
    )
    .run();
}

export type ChannelSecret = EncryptedSecret;
