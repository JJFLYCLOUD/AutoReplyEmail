import { describe, expect, it } from "vitest";
import {
  evaluateCondition,
  matchesRule,
  parseRuleMatch,
  type MatchContext,
} from "../src/worker/services/rule-engine";

const ctx: MatchContext = {
  from: "alice@customer.com",
  fromName: "Alice",
  to: ["support@example.com"],
  cc: [],
  subject: "请提供产品报价",
  body: "我们想了解 Price 和交付周期。",
  headers: { "x-tag": "vip" },
  hasAttachment: false,
};

describe("rule matching", () => {
  it("matches any keyword across subject and body", () => {
    expect(
      matchesRule(
        {
          any: [
            { field: "subject", op: "contains", value: "报价" },
            { field: "body", op: "contains", value: "price" },
          ],
        },
        ctx,
      ),
    ).toBe(true);
  });

  it("requires all conditions when using all", () => {
    expect(
      matchesRule(
        {
          all: [
            { field: "subject", op: "contains", value: "报价" },
            { field: "body", op: "contains", value: "不存在的词" },
          ],
        },
        ctx,
      ),
    ).toBe(false);
  });

  it("supports domain_in on from", () => {
    expect(
      matchesRule(
        { any: [{ field: "from", op: "domain_in", values: ["customer.com"] }] },
        ctx,
      ),
    ).toBe(true);
    expect(
      matchesRule(
        { any: [{ field: "from", op: "domain_not_in", values: ["customer.com"] }] },
        ctx,
      ),
    ).toBe(false);
  });

  it("supports header conditions", () => {
    expect(
      evaluateCondition({ field: "header:x-tag", op: "equals", value: "VIP" }, ctx),
    ).toBe(true);
  });

  it("supports regex and ignores invalid regex", () => {
    expect(evaluateCondition({ field: "subject", op: "regex", value: "报价|价格" }, ctx)).toBe(true);
    expect(evaluateCondition({ field: "subject", op: "regex", value: "([" }, ctx)).toBe(false);
  });

  it("supports exists checks", () => {
    expect(evaluateCondition({ field: "header:x-tag", op: "exists" }, ctx)).toBe(true);
    expect(evaluateCondition({ field: "header:x-missing", op: "exists" }, ctx)).toBe(false);
  });

  it("does not match when there are no conditions and matchAll is false", () => {
    expect(matchesRule({}, ctx)).toBe(false);
  });

  it("matches everything when matchAll is true", () => {
    expect(matchesRule({ matchAll: true }, ctx)).toBe(true);
  });

  it("parses stored match JSON safely", () => {
    expect(parseRuleMatch("not json")).toEqual({});
    expect(parseRuleMatch('{"any":[{"field":"subject","op":"contains","value":"x"}]}')).toEqual({
      any: [{ field: "subject", op: "contains", value: "x" }],
    });
  });
});
