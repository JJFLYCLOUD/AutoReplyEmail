/**
 * Minimal fake POP3 server for local client testing.
 * Usage: node scripts/fake-pop3.mjs [port]
 */
import net from "node:net";

const port = Number(process.argv[2] || 21025);
const header = [
  "From: Bob <bob@example.net>",
  "To: support@example.com",
  "Subject: Fake POP3 message",
  "Message-ID: <pop3-1@example.net>",
  `Date: ${new Date().toUTCString()}`,
  "Content-Type: text/plain; charset=utf-8",
];
const body = ["Hello from fake POP3. We would like a price list."];

function dotStuff(lines) {
  return lines.map((line) => (line.startsWith(".") ? `.${line}` : line));
}

const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  let authenticated = false;
  socket.write("+OK fake pop3 ready\r\n");

  socket.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const idx = buffer.indexOf("\r\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const [command, ...args] = line.split(" ");
      const upper = command.toUpperCase();

      if (upper === "USER") {
        socket.write("+OK user accepted\r\n");
      } else if (upper === "PASS") {
        authenticated = true;
        socket.write("+OK logged in\r\n");
      } else if (upper === "STAT") {
        if (!authenticated) {
          socket.write("-ERR not authenticated\r\n");
          continue;
        }
        const size = header.join("\r\n").length + body.join("\r\n").length;
        socket.write(`+OK 2 ${size}\r\n`);
      } else if (upper === "UIDL") {
        socket.write("+OK unique ids\r\n");
        socket.write("1 uid-1\r\n2 uid-2\r\n.\r\n");
      } else if (upper === "TOP") {
        const count = Number(args[1] || 0);
        socket.write("+OK top of message\r\n");
        const lines = dotStuff(count > 0 ? [...header, "", ...body.slice(0, count)] : [...header, ""]);
        socket.write(lines.join("\r\n"));
        socket.write("\r\n.\r\n");
      } else if (upper === "RETR") {
        socket.write("+OK message follows\r\n");
        socket.write(dotStuff([...header, "", ...body]).join("\r\n"));
        socket.write("\r\n.\r\n");
      } else if (upper === "QUIT") {
        socket.write("+OK bye\r\n");
        socket.end();
      } else {
        socket.write("-ERR unsupported command\r\n");
      }
    }
  });

  socket.on("error", () => {});
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake POP3 listening on 127.0.0.1:${port}`);
});
