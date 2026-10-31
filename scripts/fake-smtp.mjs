/**
 * Minimal fake SMTP server for local immediate-send tests.
 * Usage: node scripts/fake-smtp.mjs [port]
 */
import net from "node:net";

const port = Number(process.argv[2] || 2525);

const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  let dataMode = false;
  let authStep = 0;
  socket.write("220 fake-smtp ready\r\n");

  socket.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      if (dataMode) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end < 0) break;
        const data = buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        dataMode = false;
        console.log(`fake-smtp received message (${data.length} bytes)`);
        socket.write("250 2.0.0 queued\r\n");
        continue;
      }

      const idx = buffer.indexOf("\r\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const upper = line.toUpperCase();

      if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
        socket.write("250-fake-smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
      } else if (upper.startsWith("AUTH PLAIN")) {
        socket.write("235 2.7.0 authenticated\r\n");
      } else if (upper === "AUTH LOGIN") {
        authStep = 1;
        socket.write("334 VXNlcm5hbWU6\r\n");
      } else if (authStep === 1) {
        authStep = 2;
        socket.write("334 UGFzc3dvcmQ6\r\n");
      } else if (authStep === 2) {
        authStep = 0;
        socket.write("235 2.7.0 authenticated\r\n");
      } else if (upper.startsWith("MAIL FROM")) {
        socket.write("250 2.1.0 ok\r\n");
      } else if (upper.startsWith("RCPT TO")) {
        socket.write("250 2.1.5 ok\r\n");
      } else if (upper === "DATA") {
        dataMode = true;
        socket.write("354 end with <CRLF>.<CRLF>\r\n");
      } else if (upper === "QUIT") {
        socket.write("221 2.0.0 bye\r\n");
        socket.end();
      } else if (upper === "RSET" || upper === "NOOP") {
        socket.write("250 2.0.0 ok\r\n");
      } else {
        socket.write("250 2.0.0 ok\r\n");
      }
    }
  });

  socket.on("error", () => {});
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake SMTP listening on 127.0.0.1:${port}`);
});
