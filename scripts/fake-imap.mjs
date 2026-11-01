/**
 * Minimal fake IMAP server for local client testing.
 * Usage: node scripts/fake-imap.mjs [port] [--reverse-parts]
 */
import net from "node:net";

const port = Number(process.argv[2] || 20993);
const reverseParts = process.argv.includes("--reverse-parts");
const base64Multipart = process.argv.includes("--base64-multipart");
let header =
  "From: Alice <alice@example.net>\r\n" +
  "To: support@example.com\r\n" +
  "Subject: Fake IMAP message\r\n" +
  "Message-ID: <fake-1@example.net>\r\n" +
  `Date: ${new Date().toUTCString()}\r\n` +
  "Content-Type: text/plain; charset=utf-8\r\n" +
  "\r\n";
let body = "Hello from fake IMAP. We would like a price list.\r\n";

if (base64Multipart) {
  const plain = "Hello from fake IMAP. We would like a price list.";
  const html = "<html><body><p>Hello from fake IMAP. We would like a price list.</p></body></html>";
  header =
    "From: Alice <alice@example.net>\r\n" +
    "To: support@example.com\r\n" +
    "Subject: Fake IMAP base64 multipart\r\n" +
    "Message-ID: <fake-base64-1@example.net>\r\n" +
    `Date: ${new Date().toUTCString()}\r\n` +
    "MIME-Version: 1.0\r\n" +
    'Content-Type: multipart/alternative; boundary="b1"\r\n' +
    "\r\n";
  body =
    "--b1\r\n" +
    "Content-Type: text/plain; charset=UTF-8\r\n" +
    "Content-Transfer-Encoding: base64\r\n" +
    "\r\n" +
    `${Buffer.from(plain).toString("base64")}\r\n` +
    "--b1\r\n" +
    "Content-Type: text/html; charset=UTF-8\r\n" +
    "Content-Transfer-Encoding: base64\r\n" +
    "\r\n" +
    `${Buffer.from(html).toString("base64")}\r\n` +
    "--b1--\r\n";
}
const messageSize = Buffer.byteLength(header) + Buffer.byteLength(body);

const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.write("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] fake imap ready\r\n");

  socket.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const idx = buffer.indexOf("\r\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const [tag, command] = line.split(" ");
      const upper = (command || "").toUpperCase();

      if (upper === "LOGIN") {
        socket.write(`${tag} OK LOGIN completed\r\n`);
      } else if (upper === "EXAMINE" || upper === "SELECT") {
        socket.write(
          "* 2 EXISTS\r\n* OK [UIDVALIDITY 42] UIDs valid\r\n* OK [UIDNEXT 3] next UID\r\n" +
            `${tag} OK [READ-ONLY] EXAMINE completed\r\n`,
        );
      } else if (upper === "UID" && line.toUpperCase().includes("SEARCH")) {
        socket.write("* SEARCH 1 2\r\n");
        socket.write(`${tag} OK SEARCH completed\r\n`);
      } else if (upper === "UID" && line.toUpperCase().includes("FETCH")) {
        const uid = line.match(/UID FETCH (\d+)/i)?.[1] || "1";
        if (reverseParts) {
          // Intentionally return TEXT before HEADER to reproduce servers
          // that do not preserve data-item order.
          socket.write(
            `* 1 FETCH (UID ${uid} RFC822.SIZE ${messageSize} BODY[TEXT]<0> {${Buffer.byteLength(body)}}\r\n`,
          );
          socket.write(body);
          socket.write(` BODY[HEADER] {${Buffer.byteLength(header)}}\r\n`);
          socket.write(header);
          socket.write(")\r\n");
        } else {
          socket.write(
            `* 1 FETCH (UID ${uid} RFC822.SIZE ${messageSize} BODY[HEADER] {${Buffer.byteLength(header)}}\r\n`,
          );
          socket.write(header);
          socket.write(` BODY[TEXT]<0> {${Buffer.byteLength(body)}}\r\n`);
          socket.write(body);
          socket.write(")\r\n");
        }
        socket.write(`${tag} OK FETCH completed\r\n`);
      } else if (upper === "LOGOUT") {
        socket.write("* BYE fake imap logging out\r\n");
        socket.write(`${tag} OK LOGOUT completed\r\n`);
      } else if (upper === "CAPABILITY") {
        socket.write("* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n");
        socket.write(`${tag} OK CAPABILITY completed\r\n`);
      } else if (upper === "NOOP") {
        socket.write(`${tag} OK NOOP completed\r\n`);
      } else {
        socket.write(`${tag} BAD unsupported command\r\n`);
      }
    }
  });

  socket.on("error", () => {});
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake IMAP listening on 127.0.0.1:${port}`);
});
