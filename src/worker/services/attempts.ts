import { newId, now } from "../lib/util";
import type { Env, ReplyAttemptRow } from "../types";

export type ReplyAttemptStatus = "pending" | "sent" | "queued" | "skipped" | "failed";

export type InboundAggregateStatus = "replied" | "queued" | "failed" | "skipped";

export interface AttemptInput {
  inboundMessageId: string;
  mailboxId: string;
  ruleId: string;
  ruleName?: string | null;
  status: ReplyAttemptStatus;
  reason?: string | null;
  outboundMessageId?: string | null;
}

export interface AttemptPatch {
  status?: ReplyAttemptStatus;
  reason?: string | null;
  outboundMessageId?: string | null;
}

function trimReason(value: string | null | undefined): string | null {
  return value ? value.slice(0, 1000) : null;
}

/**
 * Insert or update the attempt for one (inbound email, rule) pair.
 * Processing the same inbound email again updates the existing row instead of
 * creating duplicates, so retries stay idempotent.
 */
export async function recordAttempt(env: Env, input: AttemptInput): Promise<string> {
  const timestamp = now();
  const id = newId("att");
  await env.DB.prepare(
    `INSERT INTO reply_attempts (id, inbound_message_id, mailbox_id, rule_id, rule_name,
     status, reason, outbound_message_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(inbound_message_id, rule_id) DO UPDATE SET
       rule_name = excluded.rule_name,
       status = excluded.status,
       reason = excluded.reason,
       outbound_message_id = excluded.outbound_message_id,
       updated_at = excluded.updated_at`,
  )
    .bind(
      id,
      input.inboundMessageId,
      input.mailboxId,
      input.ruleId,
      input.ruleName || null,
      input.status,
      trimReason(input.reason),
      input.outboundMessageId || null,
      timestamp,
      timestamp,
    )
    .run();

  const row = await env.DB.prepare(
    "SELECT id FROM reply_attempts WHERE inbound_message_id = ? AND rule_id = ?",
  )
    .bind(input.inboundMessageId, input.ruleId)
    .first<{ id: string }>();
  return row?.id || id;
}

export async function updateAttempt(
  env: Env,
  attemptId: string,
  patch: AttemptPatch,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE reply_attempts SET
       status = COALESCE(?, status),
       reason = ?,
       outbound_message_id = COALESCE(?, outbound_message_id),
       updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      patch.status || null,
      patch.reason === undefined ? null : trimReason(patch.reason),
      patch.outboundMessageId || null,
      now(),
      attemptId,
    )
    .run();
}

export async function listAttempts(env: Env, inboundMessageId: string): Promise<ReplyAttemptRow[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM reply_attempts WHERE inbound_message_id = ? ORDER BY created_at ASC, id ASC",
  )
    .bind(inboundMessageId)
    .all<ReplyAttemptRow>();
  return result.results || [];
}

export function aggregateAttemptStatus(
  attempts: Array<Pick<ReplyAttemptRow, "status" | "reason" | "rule_name" | "rule_id">>,
): { status: InboundAggregateStatus; error: string | null } {
  const statuses = attempts.map((attempt) => attempt.status);
  let status: InboundAggregateStatus = "skipped";
  if (statuses.includes("sent")) status = "replied";
  else if (statuses.includes("queued") || statuses.includes("pending")) status = "queued";
  else if (statuses.includes("failed")) status = "failed";

  const details = attempts
    .filter((attempt) => attempt.status === "failed" || attempt.status === "skipped")
    .map((attempt) => {
      const name = attempt.rule_name || attempt.rule_id || "规则";
      return `${name}: ${attempt.reason || attempt.status}`;
    });

  return {
    status,
    error: details.length ? details.join("; ").slice(0, 1000) : null,
  };
}

/**
 * Recompute one inbound email's status from all of its rule attempts.
 * Returns null when there is nothing to aggregate.
 */
export async function refreshInboundStatus(
  env: Env,
  inboundMessageId: string,
): Promise<{ status: InboundAggregateStatus; error: string | null } | null> {
  const attempts = await listAttempts(env, inboundMessageId);
  if (!attempts.length) return null;
  const aggregate = aggregateAttemptStatus(attempts);
  await env.DB.prepare(
    "UPDATE messages SET status = ?, error = ? WHERE id = ? AND direction = 'in'",
  )
    .bind(aggregate.status, aggregate.error, inboundMessageId)
    .run();
  return aggregate;
}
