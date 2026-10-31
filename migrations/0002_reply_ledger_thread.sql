-- Keep one reply claim per mailbox thread (not per rule).
DROP INDEX IF EXISTS idx_reply_ledger_thread;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reply_ledger_thread
  ON reply_ledger(mailbox_id, thread_key);

DROP INDEX IF EXISTS idx_reply_ledger_sender;
CREATE INDEX IF NOT EXISTS idx_reply_ledger_sender
  ON reply_ledger(mailbox_id, sender_key, replied_at);
