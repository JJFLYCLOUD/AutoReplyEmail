/**
 * Local smoke test against `wrangler dev` (port 8787).
 * Usage: node scripts/dev-smoke.mjs
 * Requires ENVIRONMENT=development and a dev user header.
 */
const BASE = process.env.BASE_URL || "http://127.0.0.1:8787";
const USER = process.env.DEV_USER || "dev@example.com";

async function call(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-Dev-User", USER);
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
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

const health = await call("/health").catch(async () => {
  const response = await fetch(`${BASE}/api/health`);
  return response.json();
});
console.log("health:", health.ok);

const email = `smoke-${Date.now()}@example.com`;
const mailbox = await call("/mailboxes", {
  method: "POST",
  body: {
    address: email,
    displayName: "Smoke Test",
    matchMode: "exact",
    timezone: "Asia/Shanghai",
    enabled: true,
    replyVia: "smtp",
    inbound: { kind: "cf_routing" },
    outbound: {
      kind: "smtp",
      host: "127.0.0.1",
      port: 2525,
      secure: false,
      username: "smoke",
      password: "smoke",
      fromName: "Smoke",
      dailyLimit: 10,
    },
  },
});
console.log("mailbox:", mailbox.mailbox.id);

const template = await call("/templates", {
  method: "POST",
  body: {
    mailboxId: mailbox.mailbox.id,
    name: "Smoke template",
    locale: "en",
    subjectTpl: "Re: {{subject}}",
    textTpl: "Hello {{sender_name}}, thanks for your price request.",
    htmlTpl: "<p>Hello {{sender_name}}, thanks for your price request.</p>",
  },
});
console.log("template:", template.id);

const rule = await call("/rules", {
  method: "POST",
  body: {
    mailboxId: mailbox.mailbox.id,
    name: "Price keyword",
    priority: 10,
    enabled: true,
    match: {
      any: [
        { field: "subject", op: "contains", value: "price" },
        { field: "body", op: "contains", value: "price" },
      ],
    },
    guards: { cooldownHours: 24, maxPerThread: 1, maxPerDay: 50 },
    action: { type: "reply", templateId: template.id, ai: { mode: "off" }, delaySeconds: 0 },
  },
});
console.log("rule:", rule.id);

const result = await call("/dev/inbound", {
  method: "POST",
  body: {
    to: email,
    from: "customer@example.net",
    fromName: "Customer",
    subject: "Price request",
    text: "Please send me the price list.",
  },
});
console.log("pipeline:", JSON.stringify(result.result));

const jobs = await call("/jobs?limit=5");
console.log("jobs:", jobs.items.map((job) => `${job.kind}/${job.status}`).join(", ") || "(none)");

if (process.env.SMOKE_DRAIN) {
  const drained = await call("/jobs/drain", { method: "POST" });
  console.log("drained:", drained.processed);
  const after = await call("/jobs?limit=5");
  console.log(
    "jobs after drain:",
    after.items.map((job) => `${job.kind}/${job.status}/attempts=${job.attempts}`).join(", ") || "(none)",
  );
  console.log("last error:", after.items[0]?.last_error?.slice(0, 160) || "(none)");
}

await call(`/mailboxes/${mailbox.mailbox.id}`, { method: "DELETE" });
console.log("cleaned up");
