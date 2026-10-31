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

const stamp = Date.now();
const template = await call("/templates", {
  method: "POST",
  body: {
    name: `Single outbound template ${stamp}`,
    locale: "en",
    subjectTpl: "Re: {{subject}}",
    textTpl: "hello",
  },
});

// 1. Changing outbound kind must leave exactly one channel.
const mailbox = await call("/mailboxes", {
  method: "POST",
  body: {
    address: `single-${stamp}@example.com`,
    matchMode: "exact",
    enabled: true,
    inbound: { kind: "cf_routing" },
    outbound: {
      kind: "smtp",
      host: "127.0.0.1",
      port: 2525,
      secure: false,
      username: "x",
      password: "x",
    },
  },
});
const mailboxId = mailbox.mailbox.id;
await call(`/mailboxes/${mailboxId}`, {
  method: "PATCH",
  body: {
    outbound: {
      kind: "resend",
      apiKey: "re_test_key",
      fromName: "Single",
      dailyLimit: 10,
    },
  },
});
const saved = (await call("/mailboxes")).items.find((item) => item.id === mailboxId);
console.log("outbound channels:", saved.outbound.length, "kind:", saved.outbound[0].kind);
await call(`/mailboxes/${mailboxId}`, { method: "DELETE" });

// 2. cf_reply on a non-CF event must fail without switching channels.
const cfMailbox = await call("/mailboxes", {
  method: "POST",
  body: {
    address: `cf-only-${stamp}@example.com`,
    matchMode: "exact",
    enabled: true,
    inbound: { kind: "cf_routing" },
    outbound: { kind: "cf_reply" },
  },
});
const cfMailboxId = cfMailbox.mailbox.id;
const rule = await call("/rules", {
  method: "POST",
  body: {
    mailboxIds: [cfMailboxId],
    name: "cf only",
    priority: 10,
    enabled: true,
    match: { any: [{ field: "subject", op: "contains", value: "cfonly" }] },
    guards: { cooldownHours: 0, maxPerThread: 1 },
    action: { type: "reply", templateId: template.id, ai: { mode: "off" }, delaySeconds: 0 },
  },
});
const result = await call("/dev/inbound", {
  method: "POST",
  body: {
    to: `cf-only-${stamp}@example.com`,
    from: "customer@example.net",
    subject: "cfonly",
    text: "hello",
  },
});
console.log("cf_reply result:", JSON.stringify(result.result));

await call(`/rules/${rule.id}`, { method: "DELETE" });
await call(`/mailboxes/${cfMailboxId}`, { method: "DELETE" });
await call(`/templates/${template.id}`, { method: "DELETE" });
console.log("cleaned up");
