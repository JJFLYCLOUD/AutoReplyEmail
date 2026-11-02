import { describe, expect, it } from "vitest";
import { aggregateAttemptStatus } from "../src/worker/services/attempts";

function attempt(
  ruleId: string,
  status: string,
  reason: string | null = null,
  ruleName: string | null = null,
) {
  return { rule_id: ruleId, rule_name: ruleName, status, reason };
}

describe("aggregateAttemptStatus", () => {
  it("marks the inbound as replied when any rule succeeded", () => {
    const result = aggregateAttemptStatus([
      attempt("rule-a", "sent"),
      attempt("rule-b", "failed", "SMTP 失败", "规则 B"),
    ]);
    expect(result.status).toBe("replied");
    expect(result.error).toContain("规则 B");
  });

  it("marks the inbound as queued when a rule is pending or queued", () => {
    expect(aggregateAttemptStatus([attempt("a", "queued"), attempt("b", "skipped")]).status).toBe(
      "queued",
    );
    expect(aggregateAttemptStatus([attempt("a", "pending"), attempt("b", "failed")]).status).toBe(
      "queued",
    );
  });

  it("marks the inbound as failed when every executed rule failed", () => {
    expect(aggregateAttemptStatus([attempt("a", "failed"), attempt("b", "skipped")]).status).toBe(
      "failed",
    );
  });

  it("marks the inbound as skipped when nothing was sent", () => {
    expect(aggregateAttemptStatus([attempt("a", "skipped"), attempt("b", "skipped")]).status).toBe(
      "skipped",
    );
  });

  it("collects skip and failure reasons", () => {
    const result = aggregateAttemptStatus([
      attempt("a", "skipped", "sender_cooldown: 冷却中", "规则 A"),
      attempt("b", "failed", "smtp_error: timeout", "规则 B"),
    ]);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("规则 A: sender_cooldown: 冷却中; 规则 B: smtp_error: timeout");
  });

  it("handles an empty attempt list", () => {
    expect(aggregateAttemptStatus([])).toEqual({ status: "skipped", error: null });
  });
});
