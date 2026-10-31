/**
 * Full POP3 poll test against scripts/fake-pop3.mjs (port 21025).
 * Usage: node scripts/dev-pop3-poll-test.mjs
 */
import { login } from "./dev-auth.mjs";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8787";
const COOKIE = await login(BASE);

async function call(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Cookie", COOKIE);
  if (options.body) headers.set("content-type", "application/json");
  const response = await fetch(`${BASE}/api${path}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} ${response.status}: ${text}`);
  return JSON.parse(text);
}

const email = `pop3-${Date.now()}@example.com`;
const mailbox = await call("/mailboxes", {
  method: "POST",
  body: {
    address: email,
    matchMode: "exact",
    enabled: true,
    inbound: {
      kind: "pop3",
      host: "127.0.0.1",
      port: 21025,
      tls: false,
      startTls: false,
      username: "test",
      password: "test",
      fetchLimit: 2,
      pollIntervalSec: 300,
    },
    outbound: {
      kind: "smtp",
      host: "127.0.0.1",
      port: 2525,
      secure: false,
      username: "x",
      password: "x",
      dailyLimit: 10,
    },
  },
});
const mailboxId = mailbox.mailbox.id;

const test = await call(`/mailboxes/${mailboxId}/test-inbound`, { method: "POST" });
console.log("test-inbound:", JSON.stringify(test));

const template = await call("/templates", {
  method: "POST",
  body: {
    name: "POP3 template",
    locale: "en",
    subjectTpl: "Re: {{subject}}",
    textTpl: "Thanks for asking about price, {{sender_name}}.",
  },
});

await call("/rules", {
  method: "POST",
  body: {
    mailboxIds: [mailboxId],
    name: "price",
    priority: 10,
    enabled: true,
    match: { any: [{ field: "body", op: "contains", value: "price" }] },
    guards: { cooldownHours: 24, maxPerThread: 1 },
    action: { type: "reply", templateId: template.id, ai: { mode: "off" }, delaySeconds: 0 },
  },
});

const poll = await call("/dev/poll", { method: "POST" });
console.log(
  "channels:",
  poll.channels.map((c) => `${c.kind}/error=${c.last_error || "-"}`).join(" | "),
);
console.log(
  "messages:",
  poll.messages.map((m) => `${m.direction}/${m.status}/${m.subject}`).join(" | ") || "(none)",
);
console.log(
  "jobs:",
  poll.jobs.map((j) => `${j.kind}/${j.status}`).join(" | ") || "(none)",
);

await call(`/mailboxes/${mailboxId}`, { method: "DELETE" });
console.log("cleaned up");
