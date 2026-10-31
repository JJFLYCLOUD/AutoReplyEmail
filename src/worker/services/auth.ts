import { SignJWT, jwtVerify } from "jose";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { AppEnv, Env, UserRow } from "../types";
import { now, safeEqual, sleep } from "../lib/util";

export const SESSION_COOKIE = "ar_session";
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_ATTEMPTS = 5;
const MIN_SESSION_SECRET_LENGTH = 16;

export interface AuthConfig {
  username: string;
  password: string;
  secret: string;
  sessionHours: number;
}

export function getAuthConfig(env: Env): AuthConfig {
  const rawHours = Number(env.AUTH_SESSION_HOURS || 12);
  const sessionHours = Number.isFinite(rawHours)
    ? Math.min(Math.max(Math.trunc(rawHours), 1), 24 * 30)
    : 12;
  return {
    username: (env.AUTH_USERNAME || "").trim(),
    password: env.AUTH_PASSWORD || "",
    secret: env.AUTH_SESSION_SECRET || "",
    sessionHours,
  };
}

export function isAuthConfigured(env: Env): boolean {
  const config = getAuthConfig(env);
  return Boolean(
    config.username &&
      config.password &&
      config.secret.length >= MIN_SESSION_SECRET_LENGTH,
  );
}

function sessionKey(config: AuthConfig): Uint8Array {
  return new TextEncoder().encode(config.secret);
}

export async function passwordVersion(password: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(password),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export async function createSession(env: Env, username: string): Promise<string> {
  const config = getAuthConfig(env);
  if (!isAuthConfigured(env)) throw new Error("认证未配置");
  return await new SignJWT({
    role: "admin",
    pwdv: await passwordVersion(config.password),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(username)
    .setIssuedAt()
    .setExpirationTime(`${config.sessionHours}h`)
    .sign(sessionKey(config));
}

export async function verifySession(env: Env, token: string): Promise<string | null> {
  const config = getAuthConfig(env);
  if (!isAuthConfigured(env)) return null;
  try {
    const { payload } = await jwtVerify(token, sessionKey(config), {
      algorithms: ["HS256"],
      clockTolerance: 5,
    });
    if (payload.sub !== config.username) return null;
    if (payload.pwdv !== (await passwordVersion(config.password))) return null;
    return config.username;
  } catch {
    return null;
  }
}

function sessionUser(username: string): UserRow {
  const timestamp = now();
  return {
    id: "env-admin",
    email: username,
    name: username,
    role: "admin",
    status: "active",
    created_at: timestamp,
    last_seen_at: timestamp,
  };
}

function isHttps(url: string): boolean {
  return new URL(url).protocol === "https:";
}

function clientKey(c: Context<AppEnv>): string {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

async function checkRateLimit(env: Env, key: string): Promise<number> {
  try {
    const row = await env.DB.prepare(
      "SELECT count, reset_at FROM login_attempts WHERE key = ?",
    )
      .bind(key)
      .first<{ count: number; reset_at: number }>();
    if (!row || row.reset_at <= now()) return 0;
    if (row.count < LOGIN_MAX_ATTEMPTS) return 0;
    return Math.max(1, Math.ceil((row.reset_at - now()) / 1000));
  } catch (error) {
    console.error("login rate limit check failed", String(error));
    return 0;
  }
}

async function recordLoginFailure(env: Env, key: string): Promise<void> {
  const timestamp = now();
  const resetAt = timestamp + LOGIN_WINDOW_MS;
  try {
    await env.DB.prepare(
      `INSERT INTO login_attempts (key, count, reset_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN login_attempts.reset_at <= ? THEN 1 ELSE login_attempts.count + 1 END,
         reset_at = CASE WHEN login_attempts.reset_at <= ? THEN ? ELSE login_attempts.reset_at END`,
    )
      .bind(key, resetAt, timestamp, timestamp, resetAt)
      .run();
  } catch (error) {
    console.error("failed to record login attempt", String(error));
  }
}

async function clearLoginFailures(env: Env, key: string): Promise<void> {
  try {
    await env.DB.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
  } catch (error) {
    console.error("failed to clear login attempts", String(error));
  }
}

export async function resolveUser(
  c: Context<AppEnv>,
  env: Env,
): Promise<UserRow | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const username = await verifySession(env, token);
  return username ? sessionUser(username) : null;
}

export async function authMiddleware(
  c: Context<AppEnv>,
  next: () => Promise<void>,
): Promise<void> {
  const pathname = new URL(c.req.url).pathname;

  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method.toUpperCase())) {
    const origin = c.req.header("origin");
    if (origin) {
      try {
        if (new URL(origin).host !== new URL(c.req.url).host) {
          c.res = c.json({ error: "invalid_origin" }, 403);
          return;
        }
      } catch {
        c.res = c.json({ error: "invalid_origin" }, 403);
        return;
      }
    }
  }

  if (
    pathname === "/api/health" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/logout"
  ) {
    await next();
    return;
  }

  const user = await resolveUser(c, c.env);
  if (!user) {
    c.res = c.json(
      { error: "unauthorized", message: "请先登录" },
      401,
    );
    return;
  }
  c.set("user", user);
  await next();
}

export async function handleLogin(c: Context<AppEnv>): Promise<Response> {
  if (!isAuthConfigured(c.env)) {
    return c.json(
      {
        error: "auth_not_configured",
        message:
          "服务端未配置登录账号。请设置 AUTH_USERNAME、AUTH_PASSWORD 和 AUTH_SESSION_SECRET。",
      },
      503,
    );
  }

  const body = (await c.req.json().catch(() => null)) as {
    username?: unknown;
    password?: unknown;
  } | null;
  if (
    !body ||
    typeof body.username !== "string" ||
    typeof body.password !== "string" ||
    !body.username.trim() ||
    !body.password
  ) {
    return c.json({ error: "invalid_request", message: "请输入账号和密码" }, 400);
  }

  const key = clientKey(c);
  const retryAfter = await checkRateLimit(c.env, key);
  if (retryAfter > 0) {
    return c.json(
      {
        error: "too_many_attempts",
        message: `尝试次数过多，请 ${Math.ceil(retryAfter / 60)} 分钟后再试`,
        retryAfter,
      },
      429,
    );
  }

  const config = getAuthConfig(c.env);
  const usernameOk = safeEqual(body.username.trim(), config.username);
  const passwordOk = safeEqual(body.password, config.password);
  if (!(usernameOk && passwordOk)) {
    await recordLoginFailure(c.env, key);
    await sleep(300);
    return c.json(
      { error: "invalid_credentials", message: "账号或密码错误" },
      401,
    );
  }

  await clearLoginFailures(c.env, key);
  const token = await createSession(c.env, config.username);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps(c.req.url),
    sameSite: "Lax",
    path: "/",
    maxAge: config.sessionHours * 3600,
  });
  c.header("cache-control", "no-store");
  return c.json({
    ok: true,
    user: sessionUser(config.username),
    sessionHours: config.sessionHours,
  });
}

export async function handleLogout(c: Context<AppEnv>): Promise<Response> {
  deleteCookie(c, SESSION_COOKIE, {
    path: "/",
    secure: isHttps(c.req.url),
  });
  c.header("cache-control", "no-store");
  return c.json({ ok: true });
}

export function requireAdmin(c: Context<AppEnv>): boolean {
  return c.get("user")?.role === "admin";
}
