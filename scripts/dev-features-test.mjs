/**
 * End-to-end checks for global templates, multi-mailbox rules,
 * orphan rule disabling, single outbound channel and domain filters.
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

const stamp = Date.now();
const addressA = `feature-a-${stamp}@example.com`;
const addressB = `feature-b-${stamp}@example.com`;

async function createMailbox(address) {
  const result = await call("/mailboxes", {
    method: "POST",
    body: {
      address,
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
        dailyLimit: 10,
      },
    },
  });
  return result.mailbox.id;
}

const mailboxA = await createMailbox(addressA);
const mailboxB = await createMailbox(addressB);

const template = await call("/templates", {
  method: "POST",
  body: {
    name: `Global template ${stamp}`,
    locale: "en",
    subjectTpl: "Re: {{subject}}",
    textTpl: "Hello {{sender_name}}, price info.",
  },
});

const rule = await call("/rules", {
  method: "POST",
  body: {
    mailboxIds: [mailboxA, mailboxB],
    name: "Domain allowlist price",
    priority: 10,
    enabled: true,
    match: {
      any: [{ field: "subject", op: "contains", value: "price" }],
      domainFilter: {
        mode: "allow",
        domains: ["customer.com"],
        includeSubdomains: true,
      },
    },
    guards: { cooldownHours: 0, maxPerThread: 1 },
    action: { type: "reply", templateId: template.id, ai: { mode: "off" }, delaySeconds: 0 },
  },
});

const mailboxes = await call("/mailboxes");
const templates = await call("/templates");
const rules = await call("/rules");
const savedRule = rules.items.find((item) => item.id === rule.id);
console.log("mailbox A outbound count:", mailboxes.items.find((m) => m.id === mailboxA).outbound.length);
console.log("mailbox B outbound count:", mailboxes.items.find((m) => m.id === mailboxB).outbound.length);
console.log("template is global:", !("mailbox_id" in templates.items.find((t) => t.id === template.id)));
console.log("rule mailboxIds:", savedRule.mailboxIds.length);
console.log("rule guards has maxPerDay:", "maxPerDay" in JSON.parse(savedRule.guards_json));

async function inbound(to, from, subject) {
  const result = await call("/dev/inbound", {
    method: "POST",
    body: { to, from, subject, text: "please send price" },
  });
  return result.result;
}

console.log("A allowed domain:", (await inbound(addressA, "alice@customer.com", "price request")).status);
console.log("B other domain:", (await inbound(addressB, "bob@other.com", "price request")).status);
console.log("B subdomain allowed:", (await inbound(addressB, "bob@mail.customer.com", "price request")).status);

await call(`/mailboxes/${mailboxA}`, { method: "DELETE" });
const afterFirstDelete = (await call("/rules")).items.find((item) => item.id === rule.id);
console.log("after deleting A:", afterFirstDelete.enabled, afterFirstDelete.mailboxIds.length);

await call(`/mailboxes/${mailboxB}`, { method: "DELETE" });
const afterSecondDelete = (await call("/rules")).items.find((item) => item.id === rule.id);
console.log("after deleting B:", afterSecondDelete.enabled, afterSecondDelete.mailboxIds.length);

console.log("template still exists:", Boolean((await call("/templates")).items.find((t) => t.id === template.id)));

await call(`/rules/${rule.id}`, { method: "DELETE" });
await call(`/templates/${template.id}`, { method: "DELETE" });
console.log("cleaned up");
