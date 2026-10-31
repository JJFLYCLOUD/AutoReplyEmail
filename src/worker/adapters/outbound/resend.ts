import type { OutboundMessage, SendResult } from "./types";

export async function sendResend(
  apiKey: string,
  message: OutboundMessage,
): Promise<SendResult> {
  if (!apiKey) throw new Error("Resend API Key 未配置");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: `${message.from.name || "Auto Reply"} <${message.from.email}>`,
      to: [message.to],
      reply_to: message.replyTo || undefined,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: message.headers,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Resend 发送失败: ${response.status} ${body}`);
  }
  let id = "";
  try {
    id = (JSON.parse(body) as { id?: string }).id || "";
  } catch {
    // ignore
  }
  return { providerMessageId: id, response: body.slice(0, 500) };
}
