import { connect } from "cloudflare:sockets";
import { bytesToBase64 } from "./crypto";

export interface ImapOptions {
  host: string;
  port: number;
  tls: boolean;
  startTls?: boolean;
  username: string;
  password: string;
  timeoutMs?: number;
}

export interface ImapMailboxInfo {
  exists: number;
  uidValidity: number;
  uidNext: number;
}

export interface ImapFetchedMessage {
  uid: number;
  size: number;
  header: string;
  body: string;
  raw: string;
}

const CRLF = new Uint8Array([13, 10]);
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function indexOfCrlf(buffer: Uint8Array): number {
  for (let i = 0; i < buffer.length - 1; i++) {
    if (buffer[i] === 13 && buffer[i + 1] === 10) return i;
  }
  return -1;
}

function quote(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("IMAP 参数包含非法换行");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`IMAP 超时: ${label}`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

interface CommandResult {
  lines: string[];
  literals: Uint8Array[];
  ok: boolean;
  text: string;
}

export class ImapClient {
  private socket: Socket;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = new Uint8Array(0);
  private tagSeq = 0;
  private timeoutMs: number;

  private constructor(socket: Socket, timeoutMs: number) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.timeoutMs = timeoutMs;
  }

  static async connect(options: ImapOptions): Promise<ImapClient> {
    if (!options.host) throw new Error("IMAP host 未配置");
    const socket = connect(
      { hostname: options.host, port: options.port || 993 },
      {
        secureTransport:
          options.tls === false ? (options.startTls === false ? "off" : "starttls") : "on",
        allowHalfOpen: false,
      },
    );
    await withTimeout(socket.opened, options.timeoutMs || 15000, "connect");
    const client = new ImapClient(socket, options.timeoutMs || 15000);
    await client.readGreeting();

    if (options.tls === false && options.startTls !== false) {
      const start = await client.command("STARTTLS");
      if (!start.ok) throw new Error(`STARTTLS 失败: ${start.text}`);
      const secure = client.socket.startTls();
      client.socket = secure;
      client.reader = secure.readable.getReader();
      client.writer = secure.writable.getWriter();
      client.buffer = new Uint8Array(0);
    }

    await client.login(options.username, options.password);
    return client;
  }

  private async readGreeting(): Promise<void> {
    const line = await this.readLine();
    if (!/^\*\s+(OK|PREAUTH)/i.test(line)) {
      throw new Error(`IMAP 服务端拒绝连接: ${line}`);
    }
  }

  private nextTag(): string {
    this.tagSeq += 1;
    return `A${String(this.tagSeq).padStart(4, "0")}`;
  }

  private async readMore(): Promise<void> {
    const result = await withTimeout(this.reader.read(), this.timeoutMs, "read");
    if (result.done) throw new Error("IMAP 连接已关闭");
    const chunk = result.value;
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
  }

  private async readRawLine(): Promise<Uint8Array> {
    while (true) {
      const idx = indexOfCrlf(this.buffer);
      if (idx >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        return line;
      }
      await this.readMore();
    }
  }

  private async readLine(): Promise<string> {
    return decoder.decode(await this.readRawLine());
  }

  private async readBytes(length: number): Promise<Uint8Array> {
    while (this.buffer.length < length) await this.readMore();
    const out = this.buffer.slice(0, length);
    this.buffer = this.buffer.slice(length);
    return out;
  }

  private async write(value: string): Promise<void> {
    await withTimeout(this.writer.write(encoder.encode(value)), this.timeoutMs, "write");
  }

  private async commandRaw(command: string, continuation?: string): Promise<CommandResult> {
    const tag = this.nextTag();
    await this.write(`${tag} ${command}\r\n`);
    const lines: string[] = [];
    const literals: Uint8Array[] = [];
    let pendingContinuation = continuation;

    while (true) {
      const line = decoder.decode(await this.readRawLine());
      lines.push(line);

      if (line.startsWith("+")) {
        if (pendingContinuation === undefined) {
          throw new Error(`IMAP 服务端请求了意外的续行: ${line}`);
        }
        await this.write(`${pendingContinuation}\r\n`);
        pendingContinuation = undefined;
        continue;
      }

      if (line.startsWith(`${tag} `)) {
        const text = line;
        return {
          lines,
          literals,
          ok: /^OK\b/i.test(line.slice(tag.length + 1).trim()),
          text,
        };
      }

      const literal = line.match(/\{(\d+)\}\s*$/);
      if (literal) {
        literals.push(await this.readBytes(Number(literal[1])));
      }
    }
  }

  private async command(command: string, continuation?: string): Promise<CommandResult> {
    return await this.commandRaw(command, continuation);
  }

  private async login(username: string, password: string): Promise<void> {
    const login = await this.command(`LOGIN ${quote(username)} ${quote(password)}`);
    if (login.ok) return;
    const token = bytesToBase64(encoder.encode(`\u0000${username}\u0000${password}`));
    const auth = await this.command("AUTHENTICATE PLAIN", token);
    if (!auth.ok) throw new Error(`IMAP 登录失败: ${login.text} / ${auth.text}`);
  }

  async select(folder = "INBOX"): Promise<ImapMailboxInfo> {
    const result = await this.command(`EXAMINE ${quote(folder)}`);
    if (!result.ok) throw new Error(`IMAP 打开文件夹失败: ${result.text}`);
    const text = result.lines.join("\n");
    const uidValidity = Number(text.match(/\[UIDVALIDITY\s+(\d+)\]/i)?.[1] || 0);
    const uidNext = Number(text.match(/\[UIDNEXT\s+(\d+)\]/i)?.[1] || 0);
    const exists = Number(text.match(/^\*\s+(\d+)\s+EXISTS/im)?.[1] || 0);
    return { exists, uidValidity, uidNext };
  }

  async searchUids(minUid: number): Promise<number[]> {
    const result = await this.command(`UID SEARCH UID ${Math.max(1, minUid)}:*`);
    if (!result.ok) throw new Error(`IMAP SEARCH 失败: ${result.text}`);
    const uids = new Set<number>();
    for (const line of result.lines) {
      if (!/^\*\s+SEARCH/i.test(line)) continue;
      for (const part of line.replace(/^\*\s+SEARCH/i, "").trim().split(/\s+/)) {
        const uid = Number(part);
        if (Number.isFinite(uid) && uid >= minUid) uids.add(uid);
      }
    }
    return [...uids].sort((a, b) => a - b);
  }

  async fetchMessage(uid: number): Promise<ImapFetchedMessage> {
    const result = await this.commandRaw(
      `UID FETCH ${uid} (UID RFC822.SIZE BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.16384>)`,
    );
    if (!result.ok) throw new Error(`IMAP FETCH 失败: ${result.text}`);
    const header = result.literals[0] ? decoder.decode(result.literals[0]) : "";
    const body = result.literals[1] ? decoder.decode(result.literals[1]) : "";
    const size = Number(result.lines.join(" ").match(/RFC822\.SIZE\s+(\d+)/i)?.[1] || header.length + body.length);
    const raw = header.endsWith("\r\n\r\n")
      ? `${header}${body}`
      : `${header}\r\n\r\n${body}`;
    return { uid, size, header, body, raw };
  }

  async logout(): Promise<void> {
    try {
      await this.command("LOGOUT");
    } catch {
      // ignore
    }
    await this.close();
  }

  async close(): Promise<void> {
    try {
      await this.writer.close();
    } catch {
      // ignore
    }
    try {
      await this.socket.close();
    } catch {
      // ignore
    }
  }
}

export { CRLF };
