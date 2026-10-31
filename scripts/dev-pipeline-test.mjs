/**
 * End-to-end pipeline checks against wrangler dev (no real outbound send).
 * Usage: node scripts/dev-pipeline-test.mjs
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
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // keep text
  }
  if (!response.ok) throw new Error(`${path} ${response.status}: ${text}`);
  return data;
}

const email = `pipeline-${Date.now()}@example.com`;
const mailbox = await call("/mailboxes", {
  method: "POST",
  body: {
    address: email,
    matchMode: "exact",
    enabled: true,
    replyVia: "smtp",
    inbound: { kind: "cf_routing" },
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

const template = await call("/templates", {
  method: "POST",
  body: {
    mailboxId,
    name: "Pipeline template",
    locale: "en",
    subjectTpl: "Re: {{subject}}",
    textTpl: "Thanks {{sender_name}}.",
  },
});

await call("/rules", {
  method: "POST",
  body: {
    mailboxId,
    name: "price",
    priority: 10,
    enabled: true,
    match: { any: [{ field: "subject", op: "contains", value: "price" }] },
    guards: { cooldownHours: 24, maxPerThread: 1, maxPerDay: 50 },
    action: { type: "reply", templateId: template.id, ai: { mode: "off" }, delaySeconds: 0 },
  },
});

async function inbound(from, subject, text = "", headers = {}) {
  const result = await call("/dev/inbound", {
    method: "POST",
    body: { to: email, from, subject, text, headers },
  });
  return result.result;
}

const cases = [];
cases.push(["first match", await inbound("customer1@example.net", "Price list", "send price")]);
cases.push(["sender cooldown", await inbound("customer1@example.net", "Price list again", "send price")]);
cases.push([
  "auto submitted",
  await inbound("customer2@example.net", "Price list", "send price", {
    "auto-submitted": "auto-replied",
  }),
]);
cases.push(["no match", await inbound("customer3@example.net", "Hello", "nothing useful")]);
cases.push([
  "references guard",
  await inbound("customer4@example.net", "Price list", "send price", {
    references: Array.from({ length: 101 }, (_, i) => `<r${i}@example.net>`).join(" "),
  }),
]);

for (const [name, result] of cases) {
  console.log(`${name}: ${result.status} ${result.reason || ""}`);
}

await call(`/mailboxes/${mailboxId}`, { method: "DELETE" });
console.log("cleaned up");
