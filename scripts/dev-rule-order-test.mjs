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
    address: `order-${stamp}@example.com`,
    matchMode: "exact",
    enabled: true,
    inbound: { kind: "cf_routing" },
    outbound: { kind: "cf_reply" },
  },
});
const template = await call("/templates", {
  method: "POST",
  body: {
    name: `Order template ${stamp}`,
    locale: "en",
    subjectTpl: "Re: {{subject}}",
    textTpl: "hello",
  },
});

const ruleIds = [];
for (const priority of [100, 10, 50]) {
  const rule = await call("/rules", {
    method: "POST",
    body: {
      mailboxIds: [mailbox.mailbox.id],
      name: `priority-${priority}`,
      priority,
      enabled: true,
      match: { any: [{ field: "subject", op: "contains", value: `p${priority}` }] },
      guards: { cooldownHours: 0, maxPerThread: 1 },
      action: { type: "reply", templateId: template.id, ai: { mode: "off" } },
    },
  });
  ruleIds.push(rule.id);
}

const rules = await call("/rules");
console.log("order:", rules.items.map((rule) => rule.priority).join(", "));

for (const id of ruleIds) await call(`/rules/${id}`, { method: "DELETE" });
await call(`/mailboxes/${mailbox.mailbox.id}`, { method: "DELETE" });
await call(`/templates/${template.id}`, { method: "DELETE" });
console.log("cleaned up");
