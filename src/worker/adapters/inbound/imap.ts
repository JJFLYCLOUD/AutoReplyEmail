import { ImapClient } from "../../lib/imap-client";
import {
  bodySnippet,
  decodeMimeWords,
  extractTextFromRaw,
  parseAddress,
  parseAddressList,
  parseHeaderBlock,
  referenceIds,
} from "../../lib/mime-lite";
import { now, parseJson } from "../../lib/util";
import { processInbound } from "../../services/inbound";
import { decryptChannelSecret } from "../../services/store";
import type { Env, InboundChannelRow, MailboxRow, NormalizedInbound } from "../../types";

export interface ImapConfig {
  host?: string;
  port?: number;
  tls?: boolean;
  startTls?: boolean;
  username?: string;
  folder?: string;
  pollIntervalSec?: number;
  initialSync?: "skip" | "recent";
  fetchLimit?: number;
}

export interface PollResult {
  processed: number;
  hasMore: boolean;
}

export async function pollImapMailbox(
  env: Env,
  mailbox: MailboxRow,
  channel: InboundChannelRow,
): Promise<PollResult> {
  const config = parseJson<ImapConfig>(channel.config_json, {});
  if (!config.host || !config.username) throw new Error("IMAP 配置不完整");
  const password = await decryptChannelSecret(env, channel);
  if (!password) throw new Error("IMAP 密码未配置");

  const client = await ImapClient.connect({
    host: config.host,
    port: config.port || 993,
    tls: config.tls !== false,
    startTls: config.startTls !== false,
    username: config.username,
    password,
    timeoutMs: 15000,
  });

  try {
    const info = await client.select(config.folder || "INBOX");
    let cursor = channel.cursor_uid || 0;

    if (channel.cursor_uidvalidity !== info.uidValidity) {
      cursor =
        config.initialSync === "recent"
          ? Math.max(0, info.uidNext - 6)
          : Math.max(0, info.uidNext - 1);
      await updateCursor(env, channel.id, info.uidValidity, cursor);
    }

    const uids = await client.searchUids(cursor + 1);
    const limit = Math.max(1, Math.min(10, config.fetchLimit || 2));
    let processed = 0;

    for (const uid of uids.slice(0, limit)) {
      const message = await client.fetchMessage(uid);
      const inbound = normalizeImapMessage(mailbox, channel, message);
      const r2Key = `raw/${mailbox.id}/imap-${uid}-${Date.now()}.eml`;
      try {
        await env.RAW.put(r2Key, inbound.raw);
        inbound.r2Key = r2Key;
      } catch (error) {
        console.error("failed to store raw imap message", String(error));
      }

      await processInbound(env, inbound);
      cursor = uid;
      await updateCursor(env, channel.id, info.uidValidity, cursor);
      processed += 1;
    }

    return { processed, hasMore: uids.length > limit };
  } finally {
    await client.logout();
  }
}

function normalizeImapMessage(
  mailbox: MailboxRow,
  channel: InboundChannelRow,
  message: { uid: number; size: number; header: string; body: string; raw: string },
): NormalizedInbound & { raw: string } {
  const headers = parseHeaderBlock(message.header || message.raw);
  const from = parseAddress(decodeMimeWords(headers.from || ""));
  const to = parseAddressList(headers.to || "").map((v) => v.email);
  const cc = parseAddressList(headers.cc || "").map((v) => v.email);
  const subject = decodeMimeWords(headers.subject || "");
  const text = extractTextFromRaw(message.raw, 16384);
  const contentType = headers["content-type"] || "";
  const receivedAt = headers.date ? Date.parse(headers.date) || now() : now();

  return {
    mailboxId: mailbox.id,
    channelId: channel.id,
    messageId: headers["message-id"] || `<imap-${channel.id}-${message.uid}-${receivedAt}@${mailbox.domain}>`,
    from: from.email,
    fromName: from.name,
    to: to.length ? to : [mailbox.address],
    cc,
    subject,
    headers,
    text,
    html: "",
    snippet: bodySnippet(text),
    rawSize: message.size || message.raw.length,
    parseMode: "headers",
    r2Key: null,
    receivedAt: Number.isFinite(receivedAt) ? receivedAt : now(),
    hasAttachment: /multipart\/mixed/i.test(contentType),
    raw: message.raw,
  };
}

async function updateCursor(
  env: Env,
  channelId: string,
  uidValidity: number,
  uid: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE inbound_channels SET cursor_uidvalidity = ?, cursor_uid = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(uidValidity, uid, now(), channelId)
    .run();
}

export async function testImapConnection(
  env: Env,
  channel: InboundChannelRow,
): Promise<{ folder: string; exists: number; uidValidity: number; uidNext: number }> {
  const config = parseJson<ImapConfig>(channel.config_json, {});
  if (!config.host || !config.username) throw new Error("IMAP 配置不完整");
  const password = await decryptChannelSecret(env, channel);
  if (!password) throw new Error("IMAP 密码未配置");
  const client = await ImapClient.connect({
    host: config.host,
    port: config.port || 993,
    tls: config.tls !== false,
    startTls: config.startTls !== false,
    username: config.username,
    password,
    timeoutMs: 15000,
  });
  try {
    const folder = config.folder || "INBOX";
    const info = await client.select(folder);
    return { folder, ...info };
  } finally {
    await client.logout();
  }
}

export async function markPollSuccess(env: Env, channelId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE inbound_channels SET last_checked_at = ?, last_error = NULL, updated_at = ?
     WHERE id = ?`,
  )
    .bind(now(), now(), channelId)
    .run();
}

export async function markPollFailure(
  env: Env,
  channelId: string,
  error: string,
  retryAt: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE inbound_channels SET last_checked_at = ?, last_error = ?, next_poll_at = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(now(), error.slice(0, 500), retryAt, now(), channelId)
    .run();
}
