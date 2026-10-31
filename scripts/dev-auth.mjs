const DEFAULT_BASE = process.env.BASE_URL || "http://127.0.0.1:8787";

export async function login(
  base = DEFAULT_BASE,
  username = process.env.AUTH_USERNAME || "admin",
  password = process.env.AUTH_PASSWORD || "dev-password",
) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    throw new Error(`login ${response.status}: ${await response.text()}`);
  }
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("login did not return a session cookie");
  const cookie = setCookie.split(";")[0];
  if (!cookie) throw new Error("empty session cookie");
  return cookie;
}
