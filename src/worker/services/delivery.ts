import {
  sendViaChannel,
  type OutboundMessage,
} from "../adapters/outbound";
import type { Env, MailboxRow, OutboundChannelRow } from "../types";
import { insertOutboundMessage, recordSendLog, updateInboundStatus } from "./message-log";

export interface DeliveryInput {
  mailbox: MailboxRow;
  channel: OutboundChannelRow;
  inboundMessageId: string;
  ruleId: string;
  threadKey: string;
  message: OutboundMessage;
}

export interface DeliveryResult {
  outboundId: string;
  providerMessageId?: string;
  durationMs: number;
}

export async function deliverOutbound(
  env: Env,
  input: DeliveryInput,
): Promise<DeliveryResult> {
  if (input.channel.status !== "active") throw new Error("发信通道已停用");
  if (input.channel.kind === "cf_reply") {
    throw new Error("cf_reply 只能即时回复 Cloudflare Email Routing 入站邮件");
  }

  const startedAt = Date.now();
  const result = await sendViaChannel(env, input.channel, input.message);

  const outboundId = await insertOutboundMessage(env, {
    mailboxId: input.mailbox.id,
    channelId: input.channel.id,
    inReplyTo: input.message.headers["In-Reply-To"] || null,
    references: (input.message.headers.References || "").split(/\s+/).filter(Boolean),
    threadKey: input.threadKey,
    from: input.message.from.email,
    fromName: input.message.from.name,
    to: input.message.to,
    subject: input.message.subject,
    text: input.message.text,
    html: input.message.html,
    ruleId: input.ruleId,
    status: "sent",
  });

  await recordSendLog(
    env,
    outboundId,
    input.channel.kind,
    result.providerMessageId || null,
    result.response || null,
  );
  await updateInboundStatus(env, input.inboundMessageId, "replied");

  const durationMs = Date.now() - startedAt;
  console.log("outbound delivered", {
    mailbox: input.mailbox.address,
    channel: input.channel.kind,
    durationMs,
  });

  return {
    outboundId,
    providerMessageId: result.providerMessageId,
    durationMs,
  };
}
