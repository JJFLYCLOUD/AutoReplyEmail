const BASE = process.env.BASE_URL || "http://127.0.0.1:8787";
const response = await fetch(`${BASE}/api/dev/imap-fetch`, {
  method: "POST",
  headers: { "content-type": "application/json", "X-Dev-User": "dev@example.com" },
  body: JSON.stringify({
    host: "127.0.0.1",
    port: Number(process.env.IMAP_PORT || 20993),
    tls: false,
    startTls: false,
    username: "test",
    password: "test",
  }),
});
console.log(response.status);
console.log(await response.text());
