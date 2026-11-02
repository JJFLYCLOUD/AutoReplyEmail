-- One inbound email can match several rules, and every rule keeps its own
-- thread / sender throttle scope. Rebuild the reply ledger indexes per rule.
DROP INDEX IF EXISTS idx_reply_ledger_thread;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reply_ledger_thread
  ON reply_ledger(mailbox_id, rule_id, thread_key);

DROP INDEX IF EXISTS idx_reply_ledger_sender;
CREATE INDEX IF NOT EXISTS idx_reply_ledger_sender
  ON reply_ledger(mailbox_id, rule_id, sender_key, replied_at);

-- Per-rule execution record for each inbound email.
CREATE TABLE IF NOT EXISTS reply_attempts (
  id TEXT PRIMARY KEY,
  inbound_message_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule_name TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  outbound_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reply_attempts_rule
  ON reply_attempts(inbound_message_id, rule_id);
CREATE INDEX IF NOT EXISTS idx_reply_attempts_inbound
  ON reply_attempts(inbound_message_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reply_attempts_mailbox
  ON reply_attempts(mailbox_id, created_at DESC);
