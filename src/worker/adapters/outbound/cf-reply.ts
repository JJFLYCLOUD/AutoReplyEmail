import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";
import type { OutboundMessage, SendResult } from "./types";

export function buildReplyMime(message: OutboundMessage): string {
  const mime = createMimeMessage();
  mime.setSender({ name: message.from.name || message.from.email, addr: message.from.email });
  mime.setRecipient(message.to);
  mime.setSubject(message.subject);
  for (const [key, value] of Object.entries(message.headers)) {
    if (value) mime.setHeader(key, value);
  }
  mime.addMessage({ contentType: "text/plain; charset=UTF-8", data: message.text });
  mime.addMessage({ contentType: "text/html; charset=UTF-8", data: message.html });
  return mime.asRaw();
}

export async function sendCfReply(
  cfMessage: ForwardableEmailMessage,
  message: OutboundMessage,
): Promise<SendResult> {
  const raw = buildReplyMime(message);
  const email = new EmailMessage(message.from.email, message.to, raw);
  await cfMessage.reply(email);
  return { response: "cloudflare-email-routing reply" };
}
