import { now } from "../lib/util";
import type { Env } from "../types";
import { loadSettings } from "./settings";

export async function runCleanup(env: Env): Promise<void> {
  const timestamp = now();
  const settings = await loadSettings(env);
  const cutoff = timestamp - Math.max(1, settings.retentionDays) * 86400_000;

  const oldMessages = await env.DB.prepare(
    "SELECT id, r2_key FROM messages WHERE received_at < ? LIMIT 200",
  )
    .bind(cutoff)
    .all<{ id: string; r2_key: string | null }>();

  for (const row of oldMessages.results || []) {
    if (row.r2_key) {
      try {
        await env.RAW.delete(row.r2_key);
      } catch (error) {
        console.error("failed to delete r2 object", row.r2_key, String(error));
      }
    }
    await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(row.id).run();
  }

  await env.DB.prepare(
    "DELETE FROM send_log WHERE created_at < ?",
  )
    .bind(timestamp - Math.max(1, settings.retentionDays) * 86400_000)
    .run();
  await env.DB.prepare(
    "DELETE FROM jobs WHERE status = 'done' AND updated_at < ?",
  )
    .bind(timestamp - 7 * 86400_000)
    .run();
  await env.DB.prepare(
    "DELETE FROM jobs WHERE status = 'dead' AND updated_at < ?",
  )
    .bind(timestamp - 30 * 86400_000)
    .run();
  await env.DB.prepare(
    "DELETE FROM suppressions WHERE expires_at IS NOT NULL AND expires_at < ?",
  )
    .bind(timestamp)
    .run();
  await env.DB.prepare(
    "DELETE FROM pop3_seen WHERE seen_at < ?",
  )
    .bind(timestamp - 365 * 86400_000)
    .run();
  await env.DB.prepare(
    "DELETE FROM login_attempts WHERE reset_at < ?",
  )
    .bind(timestamp)
    .run();
  await env.DB.prepare(
    "DELETE FROM reply_ledger WHERE replied_at < ?",
  )
    .bind(timestamp - 365 * 86400_000)
    .run();
  await env.DB.prepare(
    "DELETE FROM ai_usage WHERE day < ?",
  )
    .bind(new Date(timestamp - 90 * 86400_000).toISOString().slice(0, 10))
    .run();
}
