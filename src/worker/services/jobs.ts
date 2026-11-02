import { parseJson } from "../lib/util";
import { newId, now } from "../lib/util";
import type { Env, JobRow } from "../types";
import { type OutboundMessage } from "../adapters/outbound";
import { getMailbox, getOutboundChannel, getOutboundChannelById, listOutboundChannels } from "./store";
import { refreshInboundStatus, recordAttempt, updateAttempt } from "./attempts";
import { deliverOutbound } from "./delivery";

export interface SendJobPayload {
  mailboxId: string;
  channelId: string | null;
  inboundMessageId: string;
  ruleId: string;
  threadKey: string;
  attemptId?: string;
  message: OutboundMessage;
}

export interface EnqueueInput {
  kind: "send" | "cleanup";
  dedupeKey: string;
  payload: unknown;
  runAt?: number;
}

export async function enqueueJob(env: Env, input: EnqueueInput): Promise<void> {
  const timestamp = now();
  await env.DB.prepare(
    `INSERT INTO jobs (id, kind, dedupe_key, payload_json, status, run_at, attempts,
     max_attempts, locked_until, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, 0, 5, NULL, NULL, ?, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`,
  )
    .bind(
      newId("job"),
      input.kind,
      input.dedupeKey,
      JSON.stringify(input.payload),
      input.runAt ?? timestamp,
      timestamp,
      timestamp,
    )
    .run();
}

export async function drainJobs(env: Env, limit = 2): Promise<number> {
  const timestamp = now();
  await env.DB.prepare(
    `UPDATE jobs SET status = 'pending', locked_until = NULL, updated_at = ?
     WHERE status = 'running' AND locked_until IS NOT NULL AND locked_until < ?`,
  )
    .bind(timestamp, timestamp)
    .run();

  const due = await env.DB.prepare(
    `SELECT * FROM jobs
     WHERE status = 'pending' AND run_at <= ? AND (locked_until IS NULL OR locked_until < ?)
     ORDER BY run_at ASC LIMIT ?`,
  )
    .bind(timestamp, timestamp, limit)
    .all<JobRow>();

  let processed = 0;
  for (const job of due.results || []) {
    const claim = await env.DB.prepare(
      `UPDATE jobs SET status = 'running', locked_until = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
      .bind(timestamp + 60_000, timestamp, job.id)
      .run();
    if (!claim.meta.changes) continue;
    processed += 1;

    try {
      await runJob(env, job);
      await env.DB.prepare(
        "UPDATE jobs SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?",
      )
        .bind(now(), job.id)
        .run();
    } catch (error) {
      const attempts = job.attempts + 1;
      const message = String(error instanceof Error ? error.message : error);
      if (attempts >= job.max_attempts) {
        await env.DB.prepare(
          "UPDATE jobs SET status = 'dead', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?",
        )
          .bind(attempts, message.slice(0, 1000), now(), job.id)
          .run();
        const payload = parseJson<SendJobPayload>(job.payload_json, {} as SendJobPayload);
        if (payload.inboundMessageId) {
          if (payload.attemptId) {
            await updateAttempt(env, payload.attemptId, { status: "failed", reason: message });
          } else if (payload.ruleId) {
            await recordAttempt(env, {
              inboundMessageId: payload.inboundMessageId,
              mailboxId: payload.mailboxId,
              ruleId: payload.ruleId,
              status: "failed",
              reason: message,
            });
          }
          await refreshInboundStatus(env, payload.inboundMessageId);
        }
      } else {
        const backoffMs = Math.min(6 * 3600_000, 60_000 * Math.pow(2, attempts));
        await env.DB.prepare(
          `UPDATE jobs SET status = 'pending', attempts = ?, run_at = ?, locked_until = NULL,
           last_error = ?, updated_at = ? WHERE id = ?`,
        )
          .bind(attempts, now() + backoffMs, message.slice(0, 1000), now(), job.id)
          .run();
        const payload = parseJson<SendJobPayload>(job.payload_json, {} as SendJobPayload);
        if (payload.attemptId) {
          await updateAttempt(env, payload.attemptId, {
            status: "queued",
            reason: `发送失败，等待重试: ${message}`,
          });
        }
      }
    }
  }
  return processed;
}

async function runJob(env: Env, job: JobRow): Promise<void> {
  if (job.kind === "send") {
    await runSendJob(env, parseJson<SendJobPayload>(job.payload_json, {} as SendJobPayload));
    return;
  }
  if (job.kind === "cleanup") {
    const { runCleanup } = await import("./cleanup");
    await runCleanup(env);
    return;
  }
  throw new Error(`未知任务类型: ${job.kind}`);
}

async function runSendJob(env: Env, payload: SendJobPayload): Promise<void> {
  if (!payload.mailboxId || !payload.message) throw new Error("发送任务数据不完整");
  const mailbox = await getMailbox(env, payload.mailboxId);
  if (!mailbox) throw new Error("邮箱不存在");

  const channel = payload.channelId
    ? await getOutboundChannelById(env, payload.channelId)
    : await getOutboundChannel(env, mailbox.id);
  if (!channel) throw new Error("没有可用的发信通道");

  const result = await deliverOutbound(env, {
    mailbox,
    channel,
    inboundMessageId: payload.inboundMessageId,
    ruleId: payload.ruleId,
    threadKey: payload.threadKey,
    message: payload.message,
  });

  if (payload.attemptId) {
    await updateAttempt(env, payload.attemptId, {
      status: "sent",
      reason: null,
      outboundMessageId: result.outboundId,
    });
  } else {
    await recordAttempt(env, {
      inboundMessageId: payload.inboundMessageId,
      mailboxId: payload.mailboxId,
      ruleId: payload.ruleId,
      status: "sent",
      outboundMessageId: result.outboundId,
    });
  }
  await refreshInboundStatus(env, payload.inboundMessageId);
}

export async function listJobs(env: Env, limit = 100): Promise<JobRow[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?",
  )
    .bind(Math.min(limit, 200))
    .all<JobRow>();
  return result.results || [];
}

export async function retryJob(env: Env, id: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE jobs SET status = 'pending', attempts = 0, run_at = ?, locked_until = NULL,
     last_error = NULL, updated_at = ? WHERE id = ?`,
  )
    .bind(now(), now(), id)
    .run();
}

export { listOutboundChannels };
