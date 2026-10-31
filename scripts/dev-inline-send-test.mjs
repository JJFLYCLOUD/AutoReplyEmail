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
const mailbox = await call("/mailboxes", {
  method: "POST",
  body: {
    address: `inline-${stamp}@example.com`,
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

const template = await call("/templates", {
  method: "POST",
  body: {
    name: `Inline template ${stamp}`,
    locale: "en",
    subjectTpl: "Re: {{subject}}",
    textTpl: "hello",
  },
});

const rule = await call("/rules", {
  method: "POST",
  body: {
    mailboxIds: [mailboxId],
    name: "inline",
    priority: 10,
    enabled: true,
    match: { any: [{ field: "subject", op: "contains", value: "inline" }] },
    guards: { cooldownHours: 0, maxPerThread: 1 },
    action: { type: "reply", templateId: template.id, ai: { mode: "off" }, delaySeconds: 0 },
  },
});

const result = await call("/dev/inbound", {
  method: "POST",
  body: {
    to: `inline-${stamp}@example.com`,
    from: "customer@example.net",
    subject: "inline test",
    text: "hello",
  },
});
console.log("pipeline:", JSON.stringify(result.result));

const jobs = await call("/jobs?limit=10");
const sendJobs = jobs.items.filter((job) => job.kind === "send");
console.log("send jobs:", sendJobs.length);

const messages = await call(`/messages?mailboxId=${mailboxId}&limit=10`);
console.log(
  "messages:",
  messages.items.map((message) => `${message.direction}/${message.status}`).join(", "),
);

await call(`/rules/${rule.id}`, { method: "DELETE" });
await call(`/mailboxes/${mailboxId}`, { method: "DELETE" });
await call(`/templates/${template.id}`, { method: "DELETE" });
console.log("cleaned up");
