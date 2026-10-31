export interface User {
  id: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  created_at: number;
  last_seen_at: number | null;
}

export interface Channel {
  id: string;
  mailboxId: string;
  kind: string;
  config: Record<string, unknown>;
  status: string;
  fromName: string | null;
  replyTo: string | null;
  dailyLimit: number | null;
  cursorUidvalidity: number | null;
  cursorUid: number | null;
  lastCheckedAt: number | null;
  lastError: string | null;
  hasSecret: boolean;
}

export interface Mailbox {
  id: string;
  address: string;
  display_name: string | null;
  domain: string;
  match_mode: string;
  timezone: string;
  enabled: boolean;
  created_at: number;
  updated_at: number;
  inbound: Channel[];
  outbound: Channel[];
  ruleCount: number;
}

export interface Template {
  id: string;
  name: string;
  locale: string;
  subject_tpl: string;
  text_tpl: string;
  html_tpl: string | null;
  created_at: number;
  updated_at: number;
}

export interface Rule {
  id: string;
  mailboxIds: string[];
  name: string;
  priority: number;
  enabled: number;
  match_json: string;
  guards_json: string;
  action_json: string;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: string;
  mailbox_id: string;
  channel_id: string | null;
  direction: "in" | "out";
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

export interface Job {
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

export interface Settings {
  ai: {
    enabled: boolean;
    provider: "workers-ai" | "external";
    workersAiModel: string;
    externalBaseUrl: string;
    externalModel: string;
    dailyRequestLimit: number;
    classifyFallback: boolean;
    hasExternalApiKey: boolean;
  };
  retentionDays: number;
  globalDailyLimit: number;
  timezone: string;
}

export interface MeResponse {
  user: User;
  settings: Settings;
  auth: {
    mode: string;
    username: string;
    sessionHours: number;
    configured: boolean;
  };
}

export interface StatsResponse {
  today: {
    inbound: number;
    replied: number;
    skipped: number;
    failed: number;
    queued: number;
  };
  pendingJobs: number;
  mailboxes: number;
  aiRequests: number;
  recent: Message[];
}

export interface Suppression {
  id: string;
  mailbox_id: string | null;
  address: string;
  reason: string | null;
  expires_at: number | null;
  created_at: number;
}

export interface AuditEntry {
  id: string;
  actor: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  meta_json: string | null;
  ip: string | null;
  created_at: number;
}
