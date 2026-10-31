-- 1. Templates become global (no mailbox_id).
ALTER TABLE templates RENAME TO templates_old;

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'zh-CN',
  subject_tpl TEXT NOT NULL,
  text_tpl TEXT NOT NULL,
  html_tpl TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO templates (id, name, locale, subject_tpl, text_tpl, html_tpl, created_at, updated_at)
SELECT id, name, locale, subject_tpl, text_tpl, html_tpl, created_at, updated_at
FROM templates_old;

DROP TABLE templates_old;

-- 2. Rules can be bound to multiple mailboxes.
ALTER TABLE rules RENAME TO rules_old;

CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  match_json TEXT NOT NULL DEFAULT '{}',
  guards_json TEXT NOT NULL DEFAULT '{}',
  action_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO rules (id, name, priority, enabled, match_json, guards_json, action_json, created_at, updated_at)
SELECT id, name, priority, enabled, match_json, guards_json, action_json, created_at, updated_at
FROM rules_old;

CREATE TABLE rule_mailboxes (
  rule_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  PRIMARY KEY (rule_id, mailbox_id),
  FOREIGN KEY (rule_id) REFERENCES rules(id) ON DELETE CASCADE,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

INSERT INTO rule_mailboxes (rule_id, mailbox_id)
SELECT id, mailbox_id FROM rules_old;

DROP TABLE rules_old;

CREATE INDEX IF NOT EXISTS idx_rules_enabled ON rules(enabled, priority);
CREATE INDEX IF NOT EXISTS idx_rule_mailboxes_mailbox ON rule_mailboxes(mailbox_id, rule_id);

-- 3. Each mailbox keeps exactly one outbound channel.
-- Prefer the channel previously referenced by mailboxes.reply_via,
-- otherwise keep the most recently updated channel.
DELETE FROM outbound_channels
WHERE id NOT IN (
  SELECT id FROM (
    SELECT
      oc.id,
      ROW_NUMBER() OVER (
        PARTITION BY oc.mailbox_id
        ORDER BY
          CASE WHEN oc.kind = mb.reply_via THEN 0 ELSE 1 END,
          oc.updated_at DESC
      ) AS row_number
    FROM outbound_channels oc
    JOIN mailboxes mb ON mb.id = oc.mailbox_id
  )
  WHERE row_number = 1
);
