import { newId, now, startOfUtcDay } from "../lib/util";
import type { Env } from "../types";

export interface ThrottleInput {
  mailboxId: string;
  ruleId: string;
  threadKey: string;
  senderKey: string;
  cooldownHours: number;
  maxPerThread: number;
  maxPerDay: number;
  globalDailyLimit: number;
}

export interface ThrottleResult {
  allowed: boolean;
  code?: string;
  reason?: string;
}

export async function claimReply(env: Env, input: ThrottleInput): Promise<ThrottleResult> {
  const timestamp = now();

  if (input.cooldownHours > 0) {
    const last = await env.DB.prepare(
      `SELECT MAX(replied_at) AS last_reply FROM reply_ledger
       WHERE mailbox_id = ? AND sender_key = ?`,
    )
      .bind(input.mailboxId, input.senderKey)
      .first<{ last_reply: number | null }>();
    const cutoff = timestamp - input.cooldownHours * 3600_000;
    if (last?.last_reply && last.last_reply > cutoff) {
      return {
        allowed: false,
        code: "sender_cooldown",
        reason: `同一发件人 ${input.cooldownHours} 小时内已回复`,
      };
    }
  }

  if (input.maxPerDay > 0) {
    const dayStart = startOfUtcDay(timestamp);
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM reply_ledger
       WHERE mailbox_id = ? AND rule_id = ? AND replied_at >= ?`,
    )
      .bind(input.mailboxId, input.ruleId, dayStart)
      .first<{ count: number }>();
    if ((row?.count || 0) >= input.maxPerDay) {
      return { allowed: false, code: "rule_daily_limit", reason: "规则今日回复额度已用完" };
    }
  }

  if (input.globalDailyLimit > 0) {
    const dayStart = startOfUtcDay(timestamp);
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM messages
       WHERE mailbox_id = ? AND direction = 'out' AND status = 'sent' AND received_at >= ?`,
    )
      .bind(input.mailboxId, dayStart)
      .first<{ count: number }>();
    if ((row?.count || 0) >= input.globalDailyLimit) {
      return { allowed: false, code: "mailbox_daily_limit", reason: "邮箱今日发信额度已用完" };
    }
  }

  const claim = await env.DB.prepare(
    `INSERT INTO reply_ledger (id, mailbox_id, rule_id, thread_key, sender_key, reply_count, replied_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(mailbox_id, thread_key) DO UPDATE SET
       reply_count = reply_ledger.reply_count + 1,
       replied_at = excluded.replied_at
     WHERE reply_ledger.reply_count < ?`,
  )
    .bind(
      newId("rpl"),
      input.mailboxId,
      input.ruleId,
      input.threadKey,
      input.senderKey,
      timestamp,
      input.maxPerThread,
    )
    .run();

  if (!claim.meta.changes) {
    return { allowed: false, code: "thread_limit", reason: "该会话已达到回复次数上限" };
  }

  return { allowed: true };
}

export async function releaseReplyClaim(
  env: Env,
  mailboxId: string,
  ruleId: string,
  threadKey: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE reply_ledger SET reply_count = reply_ledger.reply_count - 1
     WHERE mailbox_id = ? AND thread_key = ? AND reply_count > 1`,
  )
    .bind(mailboxId, threadKey)
    .run();
  await env.DB.prepare(
    `DELETE FROM reply_ledger
     WHERE mailbox_id = ? AND thread_key = ? AND reply_count <= 1`,
  )
    .bind(mailboxId, threadKey)
    .run();
}
