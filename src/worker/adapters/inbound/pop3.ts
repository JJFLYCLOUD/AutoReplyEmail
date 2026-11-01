import {
  bodySnippet,
  decodeMimeWords,
  extractTextFromRaw,
  parseAddress,
  parseAddressList,
  parseHeaderBlock,
} from "../../lib/mime-lite";
import { Pop3Client } from "../../lib/pop3-client";
import { now, parseJson } from "../../lib/util";
import { processInbound } from "../../services/inbound";
import { decryptChannelSecret } from "../../services/store";
import type { Env, InboundChannelRow, MailboxRow, NormalizedInbound } from "../../types";

export interface Pop3Config {
  host?: string;
  port?: number;
  tls?: boolean;
  startTls?: boolean;
  username?: string;
  fetchLimit?: number;
}

export interface Pop3PollResult {
  processed: number;
  hasMore: boolean;
}

export async function pollPop3Mailbox(
  env: Env,
  mailbox: MailboxRow,
  channel: InboundChannelRow,
): Promise<Pop3PollResult> {
  const config = parseJson<Pop3Config>(channel.config_json, {});
  if (!config.host || !config.username) throw new Error("POP3 配置不完整");
  const password = await decryptChannelSecret(env, channel);
  if (!password) throw new Error("POP3 密码未配置");

  const client = await Pop3Client.connect({
    host: config.host,
    port: config.port || 995,
    tls: config.tls !== false,
    startTls: config.startTls !== false,
    username: config.username,
    password,
    timeoutMs: 15000,
  });

  try {
    await client.stat();
    const messages = await client.list();
    const seenRows = await env.DB.prepare("SELECT uid FROM pop3_seen WHERE channel_id = ?")
      .bind(channel.id)
      .all<{ uid: string }>();
    const seen = new Set((seenRows.results || []).map((row) => row.uid));
    const unseen = messages.filter((message) => !seen.has(message.uid));
    const limit = Math.max(1, Math.min(10, config.fetchLimit || 2));
    const batch = unseen.slice(0, limit);

    for (const item of batch) {
      const message = await client.fetch(item.index, item.uid, 300);
      const inbound = normalizePop3Message(mailbox, channel, message);
      const r2Key = `raw/${mailbox.id}/pop3-${item.index}-${Date.now()}.eml`;
      try {
        await env.RAW.put(r2Key, inbound.raw);
        inbound.r2Key = r2Key;
      } catch (error) {
        console.error("failed to store raw pop3 message", String(error));
      }

      await processInbound(env, inbound);
      await env.DB.prepare(
        "INSERT OR IGNORE INTO pop3_seen (channel_id, uid, seen_at) VALUES (?, ?, ?)",
      )
        .bind(channel.id, item.uid, now())
        .run();
    }

    return { processed: batch.length, hasMore: unseen.length > limit };
  } finally {
    await client.quit();
  }
}

function normalizePop3Message(
  mailbox: MailboxRow,
  channel: InboundChannelRow,
  message: { index: number; uid: string; header: string; body: string; raw: string },
): NormalizedInbound & { raw: string } {
  const headers = parseHeaderBlock(message.header || message.raw);
  const from = parseAddress(decodeMimeWords(headers.from || ""));
  const to = parseAddressList(headers.to || "").map((value) => value.email);
  const cc = parseAddressList(headers.cc || "").map((value) => value.email);
  const subject = decodeMimeWords(headers.subject || "");
  const text = extractTextFromRaw(message.raw, 16384);
  const contentType = headers["content-type"] || "";
  const receivedAt = headers.date ? Date.parse(headers.date) || now() : now();

  return {
    mailboxId: mailbox.id,
    channelId: channel.id,
    messageId:
      headers["message-id"] ||
      `<pop3-${channel.id}-${message.uid}-${receivedAt}@${mailbox.domain}>`,
    from: from.email,
    fromName: from.name,
    to: to.length ? to : [mailbox.address],
    cc,
    subject,
    headers,
    text,
    html: "",
    snippet: bodySnippet(text),
    rawSize: message.raw.length,
    parseMode: "headers",
    r2Key: null,
    receivedAt: Number.isFinite(receivedAt) ? receivedAt : now(),
    hasAttachment: /multipart\/mixed/i.test(contentType),
    raw: message.raw,
  };
}

export async function testPop3Connection(
  env: Env,
  channel: InboundChannelRow,
): Promise<{ count: number; size: number; unique: number }> {
  const config = parseJson<Pop3Config>(channel.config_json, {});
  if (!config.host || !config.username) throw new Error("POP3 配置不完整");
  const password = await decryptChannelSecret(env, channel);
  if (!password) throw new Error("POP3 密码未配置");
  const client = await Pop3Client.connect({
    host: config.host,
    port: config.port || 995,
    tls: config.tls !== false,
    startTls: config.startTls !== false,
    username: config.username,
    password,
    timeoutMs: 15000,
  });
  try {
    const stat = await client.stat();
    const list = await client.list();
    return { ...stat, unique: new Set(list.map((item) => item.uid)).size };
  } finally {
    await client.quit();
  }
}
