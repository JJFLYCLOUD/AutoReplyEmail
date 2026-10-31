import { LogLevel, WorkerMailer } from "worker-mailer";
import type { OutboundMessage, SendResult } from "./types";

export interface SmtpConfig {
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
}

export async function sendSmtp(
  config: SmtpConfig,
  password: string,
  message: OutboundMessage,
): Promise<SendResult> {
  const host = config.host;
  const port = config.port || 465;
  if (!host) throw new Error("SMTP host 未配置");
  if (!password) throw new Error("SMTP 密码未配置");

  await WorkerMailer.send(
    {
      host,
      port,
      secure: config.secure ?? port === 465,
      startTls: !(config.secure ?? port === 465),
      credentials: config.username
        ? { username: config.username, password }
        : undefined,
      authType: ["plain", "login"],
      logLevel: LogLevel.NONE,
      name: "auto-reply-email",
      socketTimeoutMs: 15000,
      responseTimeoutMs: 15000,
    },
    {
      from: { name: message.from.name || message.from.email, email: message.from.email },
      to: message.to,
      reply: message.replyTo || undefined,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: message.headers,
    },
  );

  return { response: "smtp accepted" };
}
