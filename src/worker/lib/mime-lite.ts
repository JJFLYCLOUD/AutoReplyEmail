const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    out[k] = out[k] ? `${out[k]}, ${value}` : value;
  });
  return out;
}

export function parseHeaderBlock(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = block.replace(/\r\n/g, "\n").split("\n");
  let currentKey = "";
  for (const line of lines) {
    if (!line) continue;
    if ((line.startsWith(" ") || line.startsWith("\t")) && currentKey) {
      out[currentKey] = `${out[currentKey]} ${line.trim()}`;
      continue;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    currentKey = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    out[currentKey] = out[currentKey] ? `${out[currentKey]}, ${value}` : value;
  }
  return out;
}

export function rawHeaderBlock(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  const idx = normalized.indexOf("\n\n");
  return idx >= 0 ? normalized.slice(0, idx) : normalized;
}

export function rawBodyBlock(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  const idx = normalized.indexOf("\n\n");
  return idx >= 0 ? normalized.slice(idx + 2) : "";
}

function decodeCharset(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return decoder.decode(bytes);
  }
}

export function decodeMimeWords(value: string): string {
  if (!value) return "";
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_all, charset, enc, data) => {
    try {
      if (enc.toUpperCase() === "B") {
        const binary = atob(data.replace(/\s+/g, ""));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return decodeCharset(bytes, charset);
      }
      const qp = data
        .replace(/_/g, " ")
        .replace(/=([0-9A-Fa-f]{2})/g, (_m: string, hex: string) =>
          String.fromCharCode(parseInt(hex, 16)),
        );
      return qp;
    } catch {
      return data;
    }
  });
}

export function decodeQuotedPrintable(value: string): string {
  const bytes: number[] = [];
  const input = value.replace(/\r\n/g, "\n");
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "=") {
      if (input[i + 1] === "\n") {
        i += 1;
        continue;
      }
      const hex = input.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(input.charCodeAt(i));
  }
  return decoder.decode(new Uint8Array(bytes));
}

export function decodeBase64Text(value: string): string {
  try {
    const binary = atob(value.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return decoder.decode(bytes);
  } catch {
    return value;
  }
}

export function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractTextFromRaw(raw: string, limit = 16384): string {
  const headers = parseHeaderBlock(rawHeaderBlock(raw));
  const body = rawBodyBlock(raw);
  const contentType = (headers["content-type"] || "").toLowerCase();
  const transfer = (headers["content-transfer-encoding"] || "").toLowerCase();

  let decoded = body;
  if (transfer.includes("base64")) decoded = decodeBase64Text(body);
  else if (transfer.includes("quoted-printable")) decoded = decodeQuotedPrintable(body);

  if (contentType.includes("text/html")) decoded = stripHtml(decoded);
  else if (contentType.includes("multipart/")) {
    decoded = decoded
      .replace(/^--[^\n]+$/gm, " ")
      .replace(
        /^(content-type|content-transfer-encoding|content-disposition|content-id|mime-version):.*$/gim,
        " ",
      );
    if (/<html|<body|<div|<p[ >]/i.test(decoded)) decoded = stripHtml(decoded);
  }

  return decoded.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, limit);
}

export interface ParsedAddress {
  name: string;
  email: string;
}

export function parseAddress(input: string | null | undefined): ParsedAddress {
  const value = (input || "").trim();
  if (!value) return { name: "", email: "" };
  const angle = value.match(/^(.*?)<([^>]+)>/);
  if (angle) {
    const name = decodeMimeWords(angle[1].trim().replace(/^"|"$/g, ""));
    return { name, email: angle[2].trim().toLowerCase() };
  }
  const email = value.replace(/^"|"$/g, "").trim().toLowerCase();
  const local = email.split("@")[0] || email;
  return { name: local, email };
}

export function parseAddressList(input: string | null | undefined): ParsedAddress[] {
  if (!input) return [];
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let inAngle = false;
  for (const ch of input) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === "<") inAngle = true;
    if (ch === ">") inAngle = false;
    if (ch === "," && !inQuote && !inAngle) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts.map(parseAddress).filter((a) => a.email);
}

export function normalizeSubject(subject: string | null | undefined): string {
  return (subject || "")
    .replace(/^((re|fwd?|aw|sv|答复|回复)\s*:\s*)+/i, "")
    .trim()
    .toLowerCase();
}

export function referenceIds(references: string | null | undefined): string[] {
  if (!references) return [];
  const matches = references.match(/<[^>]+>/g);
  if (matches?.length) return matches.map((v) => v.trim()).slice(0, 1000);
  return references
    .split(/\s+/)
    .filter(Boolean)
    .map((v) => (v.startsWith("<") ? v : `<${v}>`))
    .slice(0, 1000);
}

export function normalizeMessageId(value: string | null | undefined): string {
  if (!value) return "";
  const match = value.match(/<[^>]+>/);
  return (match ? match[0] : value).trim();
}

export function buildThreadKey(input: {
  references?: string | null;
  inReplyTo?: string | null;
  messageId?: string | null;
  subject?: string | null;
}): string {
  const refs = referenceIds(input.references);
  if (refs.length) return refs[0];
  const inReplyTo = normalizeMessageId(input.inReplyTo);
  if (inReplyTo) return inReplyTo;
  const messageId = normalizeMessageId(input.messageId);
  if (messageId) return messageId;
  return `subject:${normalizeSubject(input.subject)}`;
}

export function buildReferences(
  references: string | null | undefined,
  messageId: string | null | undefined,
): string[] {
  const refs = referenceIds(references);
  const id = normalizeMessageId(messageId);
  if (id && !refs.includes(id)) refs.push(id);
  return refs.slice(-99);
}

export function isMultipartReport(contentType: string | null | undefined): boolean {
  return (contentType || "").toLowerCase().includes("multipart/report");
}

export function headerValue(headers: Record<string, string>, name: string): string {
  return headers[name.toLowerCase()] || "";
}

export function bodySnippet(text: string, limit = 500): string {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

export { encoder };
