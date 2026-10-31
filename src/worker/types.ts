export interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  AI?: AiBinding;
  ASSETS?: Fetcher;
  ENVIRONMENT?: string;
  APP_NAME?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  DEV_AUTH_EMAIL?: string;
  CREDENTIAL_KEY?: string;
  DEFAULT_AI_MODEL?: string;
  RAW_RETENTION_DAYS?: string;
  BOOTSTRAP_ADMIN_EMAIL?: string;
}

export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  created_at: number;
  last_seen_at: number | null;
}

export interface MailboxRow {
  id: string;
  address: string;
  display_name: string | null;
  domain: string;
  match_mode: string;
  owner_id: string | null;
  timezone: string;
  enabled: number;
  reply_via: string;
  created_at: number;
  updated_at: number;
}

export interface InboundChannelRow {
  id: string;
  mailbox_id: string;
  kind: string;
  config_json: string;
  secret_ct: string | null;
  secret_iv: string | null;
  secret_kid: string | null;
  status: string;
  cursor_uidvalidity: number | null;
  cursor_uid: number | null;
  last_checked_at: number | null;
  next_poll_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface OutboundChannelRow {
  id: string;
  mailbox_id: string;
  kind: string;
  config_json: string;
  secret_ct: string | null;
  secret_iv: string | null;
  secret_kid: string | null;
  from_name: string | null;
  reply_to: string | null;
  daily_limit: number;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface RuleRow {
  id: string;
  mailbox_id: string;
  name: string;
  priority: number;
  enabled: number;
  match_json: string;
  guards_json: string;
  action_json: string;
  created_at: number;
  updated_at: number;
}

export interface TemplateRow {
  id: string;
  mailbox_id: string;
  name: string;
  locale: string;
  subject_tpl: string;
  text_tpl: string;
  html_tpl: string | null;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  mailbox_id: string;
  channel_id: string | null;
  direction: string;
  message_id: string | null;
  in_reply_to: string | null;
  references_json: string | null;
  thread_key: string | null;
  from_addr: string | null;
  from_name: string | null;
  to_json: string | null;
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  body_html: string | null;
  raw_size: number;
  parse_mode: string | null;
  r2_key: string | null;
  rule_id: string | null;
  status: string;
  error: string | null;
  received_at: number;
  created_at: number;
}

export interface JobRow {
  id: string;
  kind: string;
  dedupe_key: string;
  payload_json: string;
  status: string;
  run_at: number;
  attempts: number;
  max_attempts: number;
  locked_until: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: UserRow;
  };
};

export interface NormalizedInbound {
  mailboxId: string;
  channelId: string | null;
  messageId: string;
  from: string;
  fromName: string;
  to: string[];
  cc: string[];
  subject: string;
  headers: Record<string, string>;
  text: string;
  html: string;
  snippet: string;
  rawSize: number;
  parseMode: "full" | "headers";
  r2Key: string | null;
  receivedAt: number;
  hasAttachment: boolean;
}

export interface ReplyDraft {
  to: string;
  subject: string;
  text: string;
  html: string;
  inReplyTo: string | null;
  references: string[];
  headers: Record<string, string>;
}
