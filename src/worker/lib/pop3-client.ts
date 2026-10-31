import { connect } from "cloudflare:sockets";

export interface Pop3Options {
  host: string;
  port: number;
  tls: boolean;
  startTls?: boolean;
  username: string;
  password: string;
  timeoutMs?: number;
}

export interface Pop3Message {
  index: number;
  uid: string;
  header: string;
  body: string;
  raw: string;
}

interface Multiline {
  lines: string[];
  text: string;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`POP3 超时: ${label}`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export class Pop3Client {
  private socket: Socket;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = new Uint8Array(0);
  private timeoutMs: number;

  private constructor(socket: Socket, timeoutMs: number) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.timeoutMs = timeoutMs;
  }

  static async connect(options: Pop3Options): Promise<Pop3Client> {
    if (!options.host) throw new Error("POP3 host 未配置");
    const socket = connect(
      { hostname: options.host, port: options.port || 995 },
      {
        secureTransport:
          options.tls === false ? (options.startTls === false ? "off" : "starttls") : "on",
        allowHalfOpen: false,
      },
    );
    await withTimeout(socket.opened, options.timeoutMs || 15000, "connect");
    const client = new Pop3Client(socket, options.timeoutMs || 15000);

    const greeting = await client.readStatusLine();
    if (!greeting.startsWith("+OK")) throw new Error(`POP3 服务端拒绝连接: ${greeting}`);

    if (options.tls === false && options.startTls !== false) {
      const status = await client.command("STLS");
      if (!status.startsWith("+OK")) throw new Error(`POP3 STLS 失败: ${status}`);
      const secure = client.socket.startTls();
      client.socket = secure;
      client.reader = secure.readable.getReader();
      client.writer = secure.writable.getWriter();
      client.buffer = new Uint8Array(0);
    }

    const user = await client.command(`USER ${options.username}`);
    if (!user.startsWith("+OK")) throw new Error(`POP3 USER 失败: ${user}`);
    const pass = await client.command(`PASS ${options.password}`);
    if (!pass.startsWith("+OK")) throw new Error(`POP3 登录失败: ${pass}`);
    return client;
  }

  private async readMore(): Promise<void> {
    const result = await withTimeout(this.reader.read(), this.timeoutMs, "read");
    if (result.done) throw new Error("POP3 连接已关闭");
    const chunk = result.value;
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
  }

  private async readLine(): Promise<string> {
    while (true) {
      for (let i = 0; i < this.buffer.length - 1; i++) {
        if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) {
          const line = decoder.decode(this.buffer.slice(0, i));
          this.buffer = this.buffer.slice(i + 2);
          return line;
        }
      }
      await this.readMore();
    }
  }

  private async write(value: string): Promise<void> {
    await withTimeout(this.writer.write(encoder.encode(value)), this.timeoutMs, "write");
  }

  private async command(command: string): Promise<string> {
    await this.write(`${command}\r\n`);
    return await this.readStatusLine();
  }

  private async readStatusLine(): Promise<string> {
    return await this.readLine();
  }

  private async readMultiline(): Promise<Multiline> {
    const lines: string[] = [];
    while (true) {
      const line = await this.readLine();
      if (line === ".") break;
      lines.push(line.startsWith("..") ? line.slice(1) : line);
    }
    return { lines, text: lines.join("\r\n") };
  }

  async stat(): Promise<{ count: number; size: number }> {
    const status = await this.command("STAT");
    if (!status.startsWith("+OK")) throw new Error(`POP3 STAT 失败: ${status}`);
    const match = status.match(/\+OK\s+(\d+)\s+(\d+)/i);
    return { count: Number(match?.[1] || 0), size: Number(match?.[2] || 0) };
  }

  async list(): Promise<Array<{ index: number; uid: string }>> {
    const status = await this.command("UIDL");
    if (!status.startsWith("+OK")) throw new Error(`POP3 UIDL 失败: ${status}`);
    const body = await this.readMultiline();
    return body.lines
      .map((line) => {
        const [index, uid] = line.trim().split(/\s+/);
        return { index: Number(index), uid: uid || "" };
      })
      .filter((item) => Number.isFinite(item.index) && item.uid);
  }

  async top(index: number, lines: number): Promise<string> {
    const status = await this.command(`TOP ${index} ${lines}`);
    if (!status.startsWith("+OK")) throw new Error(`POP3 TOP 失败: ${status}`);
    const body = await this.readMultiline();
    return body.text;
  }

  async retr(index: number): Promise<string> {
    const status = await this.command(`RETR ${index}`);
    if (!status.startsWith("+OK")) throw new Error(`POP3 RETR 失败: ${status}`);
    const body = await this.readMultiline();
    return body.text;
  }

  async fetch(index: number, uid: string, bodyLines = 20): Promise<Pop3Message> {
    let header = "";
    let body = "";
    let raw = "";
    try {
      header = await this.top(index, 0);
      const full = await this.top(index, bodyLines);
      const split = full.search(/\r\n\r\n/);
      body = split >= 0 ? full.slice(split + 4) : "";
      raw = header.endsWith("\r\n\r\n") ? `${header}${body}` : `${header}\r\n\r\n${body}`;
    } catch {
      raw = await this.retr(index);
      const split = raw.search(/\r\n\r\n/);
      header = split >= 0 ? raw.slice(0, split + 2) : raw;
      body = split >= 0 ? raw.slice(split + 4) : "";
    }
    return { index, uid, header, body, raw };
  }

  async quit(): Promise<void> {
    try {
      await this.command("QUIT");
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
