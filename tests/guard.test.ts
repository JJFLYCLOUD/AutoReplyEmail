import { describe, expect, it } from "vitest";
import { evaluateStaticGuards, mergeGuardOptions, type GuardContext } from "../src/worker/services/guard";

function context(overrides: Partial<GuardContext> = {}): GuardContext {
  return {
    mailboxAddress: "support@example.com",
    from: "alice@customer.com",
    headers: {
      subject: "Hello",
      "return-path": "<alice@customer.com>",
      "content-type": "text/plain",
    },
    text: "hello",
    referencesCount: 1,
    contentType: "text/plain",
    ...overrides,
  };
}

describe("evaluateStaticGuards", () => {
  it("allows a normal human email", () => {
    expect(evaluateStaticGuards(context()).allowed).toBe(true);
  });

  it("blocks auto-submitted messages", () => {
    const result = evaluateStaticGuards(
      context({ headers: { "auto-submitted": "auto-replied" } }),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("auto_submitted");
  });

  it("allows Auto-Submitted: no", () => {
    const result = evaluateStaticGuards(
      context({ headers: { "auto-submitted": "no" } }),
    );
    expect(result.allowed).toBe(true);
  });

  it("blocks bulk precedence", () => {
    const result = evaluateStaticGuards(context({ headers: { precedence: "bulk" } }));
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("bulk");
  });

  it("blocks mailing list headers", () => {
    const result = evaluateStaticGuards(context({ headers: { "list-id": "<news.example.com>" } }));
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("list");
  });

  it("blocks X-Auto-Response-Suppress", () => {
    const result = evaluateStaticGuards(
      context({ headers: { "x-auto-response-suppress": "All" } }),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("auto_suppress");
  });

  it("blocks bounces with an empty Return-Path", () => {
    const result = evaluateStaticGuards(context({ headers: { "return-path": "<>" } }));
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("bounce");
  });

  it("blocks multipart/report", () => {
    const result = evaluateStaticGuards(
      context({ contentType: "multipart/report" }),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("bounce");
  });

  it("blocks no-reply senders", () => {
    const result = evaluateStaticGuards(context({ from: "no-reply@example.com" }));
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("no_reply");
  });

  it("blocks self replies", () => {
    const result = evaluateStaticGuards(context({ from: "support@example.com" }));
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("self");
  });

  it("allows self replies when explicitly enabled", () => {
    const result = evaluateStaticGuards(
      context({ from: "support@example.com" }),
      mergeGuardOptions({ allowSelf: true }),
    );
    expect(result.allowed).toBe(true);
  });

  it("blocks too many references", () => {
    const result = evaluateStaticGuards(context({ referencesCount: 101 }));
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("references");
  });

  it("blocks an empty sender", () => {
    const result = evaluateStaticGuards(context({ from: "" }));
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("missing_from");
  });

  it("blocks out-of-office subjects", () => {
    const result = evaluateStaticGuards(
      context({ headers: { subject: "Automatic reply: Out of office" } }),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("bounce_subject");
  });
});
