import type { OutboundMessage, SendResult } from "./types";

export interface MailgunConfig {
  domain?: string;
  region?: "us" | "eu";
}

export async function sendMailgun(
  config: MailgunConfig,
  apiKey: string,
  message: OutboundMessage,
): Promise<SendResult> {
  if (!config.domain) throw new Error("Mailgun domain 未配置");
  if (!apiKey) throw new Error("Mailgun API Key 未配置");
  const base = config.region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
  const form = new FormData();
  form.set("from", `${message.from.name || "Auto Reply"} <${message.from.email}>`);
  form.set("to", message.to);
  form.set("subject", message.subject);
  form.set("text", message.text);
  form.set("html", message.html);
  if (message.replyTo) form.set("h:Reply-To", message.replyTo);
  for (const [key, value] of Object.entries(message.headers)) {
    if (value) form.set(`h:${key}`, value);
  }

  const response = await fetch(`${base}/v3/${encodeURIComponent(config.domain)}/messages`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`api:${apiKey}`)}`,
    },
    body: form,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Mailgun 发送失败: ${response.status} ${body}`);
  }
  let id = "";
  try {
    id = (JSON.parse(body) as { id?: string }).id || "";
  } catch {
    // ignore
  }
  return { providerMessageId: id, response: body.slice(0, 500) };
}
