-- Auto Reply Email - initial schema
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'viewer',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  display_name TEXT,
  domain TEXT NOT NULL,
  match_mode TEXT NOT NULL DEFAULT 'exact',
  owner_id TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  enabled INTEGER NOT NULL DEFAULT 1,
  reply_via TEXT NOT NULL DEFAULT 'cf_reply',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mailboxes_domain ON mailboxes(domain, enabled);

CREATE TABLE IF NOT EXISTS inbound_channels (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  secret_ct TEXT,
  secret_iv TEXT,
  secret_kid TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  cursor_uidvalidity INTEGER,
  cursor_uid INTEGER,
  last_checked_at INTEGER,
  next_poll_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_channel_mailbox
  ON inbound_channels(mailbox_id, kind);
CREATE INDEX IF NOT EXISTS idx_inbound_poll
  ON inbound_channels(status, next_poll_at);

CREATE TABLE IF NOT EXISTS outbound_channels (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  secret_ct TEXT,
  secret_iv TEXT,
  secret_kid TEXT,
  from_name TEXT,
  reply_to TEXT,
  daily_limit INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_channel_mailbox
  ON outbound_channels(mailbox_id, kind);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  name TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'zh-CN',
  subject_tpl TEXT NOT NULL,
  text_tpl TEXT NOT NULL,
  html_tpl TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_templates_mailbox ON templates(mailbox_id);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  match_json TEXT NOT NULL DEFAULT '{}',
  guards_json TEXT NOT NULL DEFAULT '{}',
  action_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rules_mailbox ON rules(mailbox_id, enabled, priority);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  channel_id TEXT,
  direction TEXT NOT NULL,
  message_id TEXT,
  in_reply_to TEXT,
  references_json TEXT,
  thread_key TEXT,
  from_addr TEXT,
  from_name TEXT,
  to_json TEXT,
  subject TEXT,
  snippet TEXT,
  body_text TEXT,
  body_html TEXT,
  raw_size INTEGER NOT NULL DEFAULT 0,
  parse_mode TEXT,
  r2_key TEXT,
  rule_id TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  error TEXT,
  received_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedupe
  ON messages(mailbox_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_list
  ON messages(mailbox_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_direction
  ON messages(direction, received_at DESC);

CREATE TABLE IF NOT EXISTS send_log (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  adapter TEXT NOT NULL,
  provider_message_id TEXT,
  response TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_send_log_message ON send_log(message_id);

CREATE TABLE IF NOT EXISTS reply_ledger (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  sender_key TEXT NOT NULL,
  reply_count INTEGER NOT NULL DEFAULT 1,
  replied_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reply_ledger_thread
  ON reply_ledger(mailbox_id, thread_key);
CREATE INDEX IF NOT EXISTS idx_reply_ledger_sender
  ON reply_ledger(mailbox_id, sender_key, replied_at);

CREATE TABLE IF NOT EXISTS suppressions (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT,
  address TEXT NOT NULL,
  reason TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_suppressions_address
  ON suppressions(mailbox_id, address);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  run_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  locked_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_at);

CREATE TABLE IF NOT EXISTS ai_usage (
  day TEXT NOT NULL,
  mailbox_id TEXT NOT NULL DEFAULT '',
  requests INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, mailbox_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  meta_json TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
