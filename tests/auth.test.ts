import { describe, expect, it } from "vitest";
import {
  createSession,
  getAuthConfig,
  isAuthConfigured,
  passwordVersion,
  verifySession,
} from "../src/worker/services/auth";
import type { Env } from "../src/worker/types";

const baseEnv = {
  AUTH_USERNAME: "admin",
  AUTH_PASSWORD: "correct horse battery staple",
  AUTH_SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  AUTH_SESSION_HOURS: "12",
} as unknown as Env;

describe("password auth", () => {
  it("detects incomplete configuration", () => {
    expect(isAuthConfigured(baseEnv)).toBe(true);
    expect(isAuthConfigured({ ...baseEnv, AUTH_PASSWORD: "" } as Env)).toBe(false);
    expect(isAuthConfigured({ ...baseEnv, AUTH_SESSION_SECRET: "short" } as Env)).toBe(false);
  });

  it("clamps session hours", () => {
    expect(getAuthConfig({ ...baseEnv, AUTH_SESSION_HOURS: "0" } as Env).sessionHours).toBe(1);
    expect(getAuthConfig({ ...baseEnv, AUTH_SESSION_HOURS: "99999" } as Env).sessionHours).toBe(
      24 * 30,
    );
    expect(getAuthConfig({ ...baseEnv, AUTH_SESSION_HOURS: "abc" } as Env).sessionHours).toBe(12);
  });

  it("creates and verifies a session", async () => {
    const token = await createSession(baseEnv, "admin");
    expect(token.split(".")).toHaveLength(3);
    expect(await verifySession(baseEnv, token)).toBe("admin");
  });

  it("rejects a session after the password changes", async () => {
    const token = await createSession(baseEnv, "admin");
    const changed = {
      ...baseEnv,
      AUTH_PASSWORD: "a new password",
    } as Env;
    expect(await verifySession(changed, token)).toBeNull();
  });

  it("rejects a session after the username changes", async () => {
    const token = await createSession(baseEnv, "admin");
    const changed = { ...baseEnv, AUTH_USERNAME: "other" } as Env;
    expect(await verifySession(changed, token)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    expect(await verifySession(baseEnv, "not-a-jwt")).toBeNull();
  });

  it("hashes passwords deterministically", async () => {
    const first = await passwordVersion("secret");
    const second = await passwordVersion("secret");
    expect(first).toBe(second);
    expect(first).toHaveLength(16);
    expect(await passwordVersion("other")).not.toBe(first);
  });
});
