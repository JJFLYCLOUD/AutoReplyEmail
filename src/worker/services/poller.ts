import { now, parseJson } from "../lib/util";
import type { Env, InboundChannelRow } from "../types";
import { pollImapMailbox, markPollFailure } from "../adapters/inbound/imap";
import { pollPop3Mailbox } from "../adapters/inbound/pop3";
import { getMailbox } from "./store";

interface PollConfig {
  pollIntervalSec?: number;
}

export async function pollDueAccounts(env: Env, limit = 1): Promise<void> {
  const timestamp = now();
  const due = await env.DB.prepare(
    `SELECT ic.* FROM inbound_channels ic
     JOIN mailboxes mb ON mb.id = ic.mailbox_id
     WHERE ic.status = 'active' AND mb.enabled = 1
       AND ic.kind IN ('imap', 'pop3')
       AND (ic.next_poll_at IS NULL OR ic.next_poll_at <= ?)
     ORDER BY COALESCE(ic.next_poll_at, 0) ASC LIMIT ?`,
  )
    .bind(timestamp, limit)
    .all<InboundChannelRow>();

  for (const channel of due.results || []) {
    const config = parseJson<PollConfig>(channel.config_json, {});
    const intervalMs = Math.max(60, Math.min(3600, config.pollIntervalSec || 300)) * 1000;

    await env.DB.prepare(
      `UPDATE inbound_channels SET last_checked_at = ?, next_poll_at = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(timestamp, timestamp + intervalMs, timestamp, channel.id)
      .run();

    const mailbox = await getMailbox(env, channel.mailbox_id);
    if (!mailbox || !mailbox.enabled) continue;

    try {
      const result =
        channel.kind === "pop3"
          ? await pollPop3Mailbox(env, mailbox, channel)
          : await pollImapMailbox(env, mailbox, channel);
      await env.DB.prepare(
        `UPDATE inbound_channels SET last_error = NULL, next_poll_at = ?, updated_at = ?
         WHERE id = ?`,
      )
        .bind(now() + (result.hasMore ? 2000 : intervalMs), now(), channel.id)
        .run();
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      await markPollFailure(
        env,
        channel.id,
        message,
        now() + Math.max(intervalMs, 300_000),
      );
      console.error("imap poll failed", channel.id, message);
    }
  }
}
