import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Context } from "hono";
import type { AppEnv, Env, UserRow } from "../types";
import { newId, now } from "../lib/util";

let jwksCache: { issuer: string; jwks: ReturnType<typeof createRemoteJWKSet> } | null = null;

function teamIssuer(env: Env): string {
  const team = (env.ACCESS_TEAM_DOMAIN || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  return team ? `https://${team}` : "";
}

export async function verifyAccessJwt(token: string, env: Env): Promise<string> {
  const issuer = teamIssuer(env);
  if (!issuer || !env.ACCESS_AUD) {
    throw new Error("Cloudflare Access 未配置（ACCESS_TEAM_DOMAIN / ACCESS_AUD）");
  }
  if (!jwksCache || jwksCache.issuer !== issuer) {
    jwksCache = {
      issuer,
      jwks: createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)),
    };
  }
  const { payload } = await jwtVerify(token, jwksCache.jwks, {
    issuer,
    audience: env.ACCESS_AUD,
  });
  const email =
    (typeof payload.email === "string" && payload.email) ||
    (typeof payload.sub === "string" && payload.sub.includes("@") ? payload.sub : "");
  if (!email) throw new Error("Access JWT 中缺少 email");
  return email.toLowerCase();
}

export async function upsertUser(env: Env, email: string): Promise<UserRow> {
  const normalized = email.toLowerCase();
  const existing = await env.DB.prepare("SELECT * FROM users WHERE email = ?")
    .bind(normalized)
    .first<UserRow>();
  const timestamp = now();
  if (existing) {
    if (existing.status !== "active") throw new Error("用户已被禁用");
    if (!existing.last_seen_at || timestamp - existing.last_seen_at > 5 * 60_000) {
      await env.DB.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?")
        .bind(timestamp, existing.id)
        .run();
      return { ...existing, last_seen_at: timestamp };
    }
    return existing;
  }

  const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  const bootstrap = (env.BOOTSTRAP_ADMIN_EMAIL || "").toLowerCase();
  const role = countRow?.count === 0 || normalized === bootstrap ? "admin" : "viewer";
  const user: UserRow = {
    id: newId("usr"),
    email: normalized,
    name: null,
    role,
    status: "active",
    created_at: timestamp,
    last_seen_at: timestamp,
  };
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, role, status, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(user.id, user.email, user.name, user.role, user.status, user.created_at, user.last_seen_at)
    .run();
  return user;
}

export async function resolveUser(request: Request, env: Env): Promise<UserRow | null> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (token) {
    try {
      const email = await verifyAccessJwt(token, env);
      return await upsertUser(env, email);
    } catch (error) {
      console.error("access jwt verification failed", String(error));
      return null;
    }
  }

  if (env.ENVIRONMENT !== "production") {
    const devEmail =
      request.headers.get("X-Dev-User")?.trim() || (env.DEV_AUTH_EMAIL || "").trim();
    if (devEmail) return await upsertUser(env, devEmail);
  }

  return null;
}

export async function authMiddleware(c: Context<AppEnv>, next: () => Promise<void>): Promise<void> {
  if (new URL(c.req.url).pathname === "/api/health") {
    await next();
    return;
  }
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
  const user = await resolveUser(c.req.raw, c.env);
  if (!user) {
    c.res = c.json(
      {
        error: "unauthorized",
        message:
          "需要 Cloudflare Access 登录。开发环境请在 .dev.vars 配置 DEV_AUTH_EMAIL，或发送 X-Dev-User 请求头。",
      },
      401,
    );
    return;
  }
  c.set("user", user);
  await next();
}

export function requireAdmin(c: Context<AppEnv>): boolean {
  return c.get("user")?.role === "admin";
}
