-- Track POP3 UIDL values already processed per channel.
CREATE TABLE IF NOT EXISTS pop3_seen (
  channel_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_pop3_seen_time ON pop3_seen(seen_at);
