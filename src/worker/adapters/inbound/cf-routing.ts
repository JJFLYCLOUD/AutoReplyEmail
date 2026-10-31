import PostalMime from "postal-mime";
import {
  bodySnippet,
  decodeMimeWords,
  extractTextFromRaw,
  headersToRecord,
  parseAddress,
  parseAddressList,
  parseHeaderBlock,
  stripHtml,
} from "../../lib/mime-lite";
import { newId, now } from "../../lib/util";
import { processInbound } from "../../services/inbound";
import { findMailboxForRecipient } from "../../services/store";
import type { Env, NormalizedInbound } from "../../types";

const MAX_FULL_PARSE_BYTES = 128 * 1024;
const HEADER_PREFIX_BYTES = 64 * 1024;

export async function handleCloudflareEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const mailbox = await findMailboxForRecipient(env, message.to);
  if (!mailbox) {
    console.warn("no mailbox configured for recipient", message.to);
    return;
  }

  const baseHeaders = headersToRecord(message.headers);
  const rawKey = `raw/${mailbox.id}/${Date.now()}-${newId("cf")}.eml`;
  const [forStorage, forParse] = message.raw.tee();

  ctx.waitUntil(
    env.RAW.put(rawKey, forStorage).catch((error) => {
      console.error("failed to store raw cf email", String(error));
    }),
  );

  let parsed: Awaited<ReturnType<typeof PostalMime.parse>> | null = null;
  let prefix = "";
  const rawSize = message.rawSize || 0;

  try {
    if (rawSize <= MAX_FULL_PARSE_BYTES) {
      parsed = await PostalMime.parse(forParse);
    } else {
      prefix = await readPrefix(forParse, HEADER_PREFIX_BYTES);
    }
  } catch (error) {
    console.error("failed to parse cf email", String(error));
    try {
      prefix = await readPrefix(forParse, HEADER_PREFIX_BYTES);
    } catch {
      // stream may already be consumed
    }
  }

  const parsedHeaders: Record<string, string> = {};
  if (parsed?.headers) {
    for (const header of parsed.headers) {
      const key = header.key.toLowerCase();
      parsedHeaders[key] = parsedHeaders[key]
        ? `${parsedHeaders[key]}, ${header.value}`
        : header.value;
    }
  }
  const prefixHeaders = prefix ? parseHeaderBlock(prefix) : {};
  const headers = { ...prefixHeaders, ...baseHeaders, ...parsedHeaders };

  const fromAddress = parsed?.from
    ? parseAddressFromObject(parsed.from)
    : parseAddress(headers.from || message.from);
  const toList = parsed?.to
    ? parsed.to.map(parseAddressFromObject).filter((item) => item.email)
    : parseAddressList(headers.to || message.to);
  const ccList = parsed?.cc ? parsed.cc.map(parseAddressFromObject).filter((item) => item.email) : [];

  const text =
    parsed?.text ||
    (parsed?.html ? stripHtml(parsed.html) : prefix ? extractTextFromRaw(prefix, 16384) : "");
  const html = parsed?.html || "";
  const messageId =
    parsed?.messageId || headers["message-id"] || `<cf-${newId("mid")}@${mailbox.domain}>`;
  const receivedAt = parsed?.date ? Date.parse(parsed.date) || now() : now();

  const envelopeFrom = (message.from || "").trim().toLowerCase();
  const toEmails = toList.map((item) => item.email).filter(Boolean);
  const envelopeTo = message.to.trim().toLowerCase();
  if (envelopeTo && !toEmails.includes(envelopeTo)) toEmails.unshift(envelopeTo);

  const inbound: NormalizedInbound = {
    mailboxId: mailbox.id,
    channelId: null,
    messageId,
    from: envelopeFrom || fromAddress.email,
    fromName: fromAddress.name || "",
    to: toEmails.length ? toEmails : [message.to],
    cc: ccList.map((item) => item.email),
    subject: parsed?.subject || decodeMimeWords(headers.subject || ""),
    headers,
    text,
    html,
    snippet: bodySnippet(text),
    rawSize,
    parseMode: parsed ? "full" : "headers",
    r2Key: rawKey,
    receivedAt,
    hasAttachment: Boolean(parsed?.attachments?.length),
  };

  await processInbound(env, inbound, { cfMessage: message });
}

function parseAddressFromObject(value: { name?: string; address?: string }): {
  name: string;
  email: string;
} {
  return {
    name: value.name || "",
    email: (value.address || "").toLowerCase(),
  };
}

async function readPrefix(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = limit - total;
      const chunk = value.length > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.length;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}
