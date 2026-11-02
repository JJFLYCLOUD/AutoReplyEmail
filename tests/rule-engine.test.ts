import { describe, expect, it } from "vitest";
import {
  evaluateCondition,
  matchesRule,
  parseRuleAction,
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

describe("sender domain filter", () => {
  const allow = (domains: string[], includeSubdomains = true) =>
    matchesRule(
      {
        matchAll: true,
        domainFilter: { mode: "allow", domains, includeSubdomains },
      },
      ctx,
    );

  const deny = (domains: string[], includeSubdomains = true) =>
    matchesRule(
      {
        matchAll: true,
        domainFilter: { mode: "deny", domains, includeSubdomains },
      },
      ctx,
    );

  it("allows an exact domain", () => {
    expect(allow(["customer.com"])).toBe(true);
    expect(allow(["example.com"])).toBe(false);
  });

  it("allows subdomains when enabled", () => {
    const subdomainCtx = { ...ctx, from: "alice@mail.customer.com" };
    expect(
      matchesRule(
        {
          matchAll: true,
          domainFilter: { mode: "allow", domains: ["customer.com"], includeSubdomains: true },
        },
        subdomainCtx,
      ),
    ).toBe(true);
    expect(
      matchesRule(
        {
          matchAll: true,
          domainFilter: { mode: "allow", domains: ["customer.com"], includeSubdomains: false },
        },
        subdomainCtx,
      ),
    ).toBe(false);
  });

  it("does not match lookalike domains", () => {
    expect(allow(["customer.com"])).toBe(true);
    expect(
      matchesRule(
        {
          matchAll: true,
          domainFilter: { mode: "allow", domains: ["customer.com"], includeSubdomains: true },
        },
        { ...ctx, from: "alice@notcustomer.com" },
      ),
    ).toBe(false);
  });

  it("denies listed domains", () => {
    expect(deny(["customer.com"])).toBe(false);
    expect(deny(["example.com"])).toBe(true);
  });

  it("fails closed when an allowlist is empty", () => {
    expect(allow([])).toBe(false);
    expect(deny([])).toBe(true);
  });

  it("normalizes @, *. and case", () => {
    expect(allow(["@CUSTOMER.COM"])).toBe(true);
    expect(allow(["*.Customer.com"])).toBe(true);
  });

  it("applies together with matchAll and keyword conditions", () => {
    expect(
      matchesRule(
        {
          matchAll: true,
          domainFilter: { mode: "allow", domains: ["example.com"], includeSubdomains: true },
        },
        ctx,
      ),
    ).toBe(false);
    expect(
      matchesRule(
        {
          any: [{ field: "subject", op: "contains", value: "报价" }],
          domainFilter: { mode: "deny", domains: ["customer.com"], includeSubdomains: true },
        },
        ctx,
      ),
    ).toBe(false);
  });

  it("parses domainFilter from stored JSON", () => {
    const parsed = parseRuleMatch(
      '{"matchAll":true,"domainFilter":{"mode":"allow","domains":["customer.com"],"includeSubdomains":false}}',
    );
    expect(parsed.domainFilter).toEqual({
      mode: "allow",
      domains: ["customer.com"],
      includeSubdomains: false,
    });
  });
});

describe("rule action", () => {
  it("defaults replyAsNew to false", () => {
    const action = parseRuleAction(JSON.stringify({ templateId: "tpl_1" }));
    expect(action?.replyAsNew).toBe(false);
  });

  it("parses replyAsNew true", () => {
    const action = parseRuleAction(
      JSON.stringify({ templateId: "tpl_1", replyAsNew: true }),
    );
    expect(action?.replyAsNew).toBe(true);
  });

  it("rejects an invalid replyAsNew value", () => {
    expect(
      parseRuleAction(JSON.stringify({ templateId: "tpl_1", replyAsNew: "yes" })),
    ).toBeNull();
  });
});
