/**
 * Local auth smoke test.
 * Usage: node scripts/dev-auth-test.mjs
 */
const BASE = process.env.BASE_URL || "http://127.0.0.1:8787";
const USERNAME = process.env.AUTH_USERNAME || "admin";
const PASSWORD = process.env.AUTH_PASSWORD || "dev-password";

async function post(path, body, headers = {}) {
  const response = await fetch(`${BASE}/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return response;
}

const noCookie = await fetch(`${BASE}/api/me`);
console.log("me without cookie:", noCookie.status);

const wrong = await post("/auth/login", { username: USERNAME, password: "wrong" });
console.log("wrong password:", wrong.status, (await wrong.json()).message);

const login = await post("/auth/login", { username: USERNAME, password: PASSWORD });
const setCookie = login.headers.get("set-cookie") || "";
const cookie = setCookie.split(";")[0];
console.log("login:", login.status, "cookie:", Boolean(cookie), "httponly:", /HttpOnly/i.test(setCookie));

const me = await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } });
const meData = await me.json();
console.log("me:", me.status, "mode:", meData.auth?.mode, "username:", meData.auth?.username);

const logout = await fetch(`${BASE}/api/auth/logout`, {
  method: "POST",
  headers: { Cookie: cookie },
});
const logoutSetCookie = logout.headers.get("set-cookie") || "";
const clearedCookie = logoutSetCookie.split(";")[0];
console.log("logout:", logout.status, "cleared cookie:", /Max-Age=0/i.test(logoutSetCookie));

const afterLogout = await fetch(`${BASE}/api/me`, { headers: { Cookie: clearedCookie } });
console.log("me after logout:", afterLogout.status);

const testIp = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
for (let i = 1; i <= 6; i += 1) {
  const response = await post(
    "/auth/login",
    { username: USERNAME, password: "wrong" },
    { "cf-connecting-ip": testIp },
  );
  console.log(`rate limit attempt ${i}:`, response.status);
}
