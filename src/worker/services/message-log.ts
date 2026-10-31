import { bodySnippet } from "../lib/mime-lite";
import { newId, now } from "../lib/util";
import type { Env, MessageRow } from "../types";

export async function updateInboundStatus(
  env: Env,
  id: string,
  status: string,
  error?: string | null,
): Promise<void> {
  await env.DB.prepare("UPDATE messages SET status = ?, error = ? WHERE id = ?")
    .bind(status, error ? error.slice(0, 1000) : null, id)
    .run();
}

export interface OutboundLogInput {
  mailboxId: string;
  channelId: string | null;
  inReplyTo: string | null;
  references: string[];
  threadKey: string;
  from: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  ruleId: string | null;
  status: string;
  error?: string | null;
}

export async function insertOutboundMessage(env: Env, input: OutboundLogInput): Promise<string> {
  const id = newId("msg");
  const timestamp = now();
  await env.DB.prepare(
    `INSERT INTO messages (id, mailbox_id, channel_id, direction, message_id, in_reply_to,
     references_json, thread_key, from_addr, from_name, to_json, subject, snippet,
     body_text, body_html, raw_size, parse_mode, r2_key, rule_id, status, error,
     received_at, created_at)
     VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.mailboxId,
      input.channelId,
      `<${newId("out")}@auto-reply.local>`,
      input.inReplyTo,
      JSON.stringify(input.references),
      input.threadKey,
      input.from,
      input.fromName,
      JSON.stringify([input.to]),
      input.subject,
      bodySnippet(input.text),
      input.text,
      input.html,
      input.text.length + input.html.length,
      input.ruleId,
      input.status,
      input.error ? input.error.slice(0, 1000) : null,
      timestamp,
      timestamp,
    )
    .run();
  return id;
}

export async function recordSendLog(
  env: Env,
  messageId: string,
  adapter: string,
  providerMessageId: string | null,
  response: string | null,
  attempt = 1,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO send_log (id, message_id, attempt, adapter, provider_message_id, response, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      newId("log"),
      messageId,
      attempt,
      adapter,
      providerMessageId,
      response ? response.slice(0, 1000) : null,
      now(),
    )
    .run();
}

export async function listMessages(
  env: Env,
  options: {
    mailboxId?: string;
    direction?: string;
    status?: string;
    search?: string;
    limit?: number;
    offset?: number;
  },
): Promise<MessageRow[]> {
  const where: string[] = [];
  const bindings: unknown[] = [];
  if (options.mailboxId) {
    where.push("mailbox_id = ?");
    bindings.push(options.mailboxId);
  }
  if (options.direction) {
    where.push("direction = ?");
    bindings.push(options.direction);
  }
  if (options.status) {
    where.push("status = ?");
    bindings.push(options.status);
  }
  if (options.search) {
    where.push("(subject LIKE ? OR from_addr LIKE ? OR to_json LIKE ?)");
    const like = `%${options.search}%`;
    bindings.push(like, like, like);
  }
  const limit = Math.min(Math.max(options.limit || 50, 1), 200);
  const offset = Math.max(options.offset || 0, 0);
  bindings.push(limit, offset);
  const result = await env.DB.prepare(
    `SELECT * FROM messages ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY received_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...bindings)
    .all<MessageRow>();
  return result.results || [];
}

export async function getMessage(env: Env, id: string): Promise<MessageRow | null> {
  return await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first<MessageRow>();
}
