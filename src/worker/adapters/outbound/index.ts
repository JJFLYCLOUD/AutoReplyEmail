import { parseJson } from "../../lib/util";
import type { Env, MailboxRow, OutboundChannelRow } from "../../types";
import { decryptChannelSecret, listOutboundChannels } from "../../services/store";
import { sendCfReply } from "./cf-reply";
import { sendMailgun, type MailgunConfig } from "./mailgun";
import { sendResend } from "./resend";
import { sendSmtp, type SmtpConfig } from "./smtp";
import type { OutboundMessage, SendResult } from "./types";

export type { OutboundMessage, SendResult } from "./types";

export async function sendViaChannel(
  env: Env,
  channel: OutboundChannelRow,
  message: OutboundMessage,
  cfMessage?: ForwardableEmailMessage,
): Promise<SendResult> {
  const config = parseJson<Record<string, unknown>>(channel.config_json, {});
  const secret = await decryptChannelSecret(env, channel);

  switch (channel.kind) {
    case "cf_reply":
      if (!cfMessage) throw new Error("cf_reply 只能用于 Cloudflare Email Routing 入站邮件");
      return await sendCfReply(cfMessage, message);
    case "smtp":
      return await sendSmtp(config as SmtpConfig, secret, message);
    case "resend":
      return await sendResend(secret, message);
    case "mailgun":
      return await sendMailgun(config as MailgunConfig, secret, message);
    default:
      throw new Error(`不支持的发信通道: ${channel.kind}`);
  }
}

const KIND_ORDER = ["cf_reply", "smtp", "resend", "mailgun"];

export async function resolveOutboundCandidates(
  env: Env,
  mailbox: MailboxRow,
): Promise<OutboundChannelRow[]> {
  const channels = (await listOutboundChannels(env, mailbox.id)).filter(
    (channel) => channel.status === "active",
  );
  const preferred = mailbox.reply_via;
  return channels.sort((a, b) => {
    const aPreferred = a.kind === preferred ? 0 : 1;
    const bPreferred = b.kind === preferred ? 0 : 1;
    if (aPreferred !== bPreferred) return aPreferred - bPreferred;
    return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  });
}

export function outboundMessageFrom(
  mailbox: MailboxRow,
  channel: OutboundChannelRow | null,
  input: {
    to: string;
    subject: string;
    text: string;
    html: string;
    headers: Record<string, string>;
  },
): OutboundMessage {
  return {
    from: {
      name: channel?.from_name || mailbox.display_name || mailbox.address,
      email: mailbox.address,
    },
    to: input.to,
    replyTo: channel?.reply_to || null,
    subject: input.subject,
    text: input.text,
    html: input.html,
    headers: input.headers,
  };
}
