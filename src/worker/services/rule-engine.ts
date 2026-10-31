import { z } from "zod";
import { addressDomain } from "../lib/util";

export const conditionSchema = z.object({
  field: z.string().min(1),
  op: z.enum([
    "contains",
    "not_contains",
    "equals",
    "not_equals",
    "starts_with",
    "ends_with",
    "regex",
    "domain_in",
    "domain_not_in",
    "exists",
    "not_exists",
  ]),
  value: z.string().optional(),
  values: z.array(z.string()).optional(),
  caseSensitive: z.boolean().optional(),
});

export const ruleMatchSchema = z.object({
  all: z.array(conditionSchema).optional(),
  any: z.array(conditionSchema).optional(),
  matchAll: z.boolean().optional(),
});

export const businessHoursSchema = z.object({
  timezone: z.string().default("UTC"),
  start: z.string().default("09:00"),
  end: z.string().default("18:00"),
  days: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
});

export const ruleGuardsSchema = z.object({
  skipAutoSubmitted: z.boolean().optional(),
  skipBulk: z.boolean().optional(),
  skipNoReply: z.boolean().optional(),
  skipBounces: z.boolean().optional(),
  maxReferences: z.number().int().min(1).max(100).optional(),
  allowSelf: z.boolean().optional(),
  cooldownHours: z.number().min(0).max(24 * 365).optional(),
  maxPerThread: z.number().int().min(1).max(100).optional(),
  maxPerDay: z.number().int().min(1).max(10000).optional(),
  businessHours: businessHoursSchema.nullable().optional(),
});

export const aiOptionsSchema = z.object({
  mode: z.enum(["off", "classify", "polish"]).default("off"),
  provider: z.enum(["workers-ai", "external"]).optional(),
});

export const ruleActionSchema = z.object({
  type: z.literal("reply").default("reply"),
  templateId: z.string().min(1),
  ai: aiOptionsSchema.optional(),
  delaySeconds: z.number().int().min(0).max(86400).optional(),
});

export const ruleInputSchema = z.object({
  name: z.string().min(1).max(120),
  priority: z.number().int().min(0).max(100000).default(100),
  enabled: z.boolean().default(true),
  match: ruleMatchSchema.default({}),
  guards: ruleGuardsSchema.default({}),
  action: ruleActionSchema,
});

export type Condition = z.infer<typeof conditionSchema>;
export type RuleMatch = z.infer<typeof ruleMatchSchema>;
export type RuleGuards = z.infer<typeof ruleGuardsSchema>;
export type RuleAction = z.infer<typeof ruleActionSchema>;
export type RuleInput = z.infer<typeof ruleInputSchema>;

export interface MatchContext {
  from: string;
  fromName: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  headers: Record<string, string>;
  hasAttachment: boolean;
}

function fieldValues(field: string, ctx: MatchContext): string[] {
  const key = field.toLowerCase();
  if (key === "from" || key === "sender") return [ctx.from, ctx.fromName].filter(Boolean);
  if (key === "to") return ctx.to;
  if (key === "cc") return ctx.cc;
  if (key === "subject") return [ctx.subject];
  if (key === "body" || key === "text") return [ctx.body];
  if (key === "attachment" || key === "has_attachment") return [String(ctx.hasAttachment)];
  if (key.startsWith("header:")) {
    const name = key.slice(7);
    return [ctx.headers[name] || ""];
  }
  return [""];
}

function textMatch(actual: string, op: string, value: string, caseSensitive: boolean): boolean {
  const a = caseSensitive ? actual : actual.toLowerCase();
  const b = caseSensitive ? value : value.toLowerCase();
  switch (op) {
    case "contains":
      return a.includes(b);
    case "not_contains":
      return !a.includes(b);
    case "equals":
      return a === b;
    case "not_equals":
      return a !== b;
    case "starts_with":
      return a.startsWith(b);
    case "ends_with":
      return a.endsWith(b);
    case "regex": {
      if (value.length > 500) return false;
      try {
        return new RegExp(value, caseSensitive ? "" : "i").test(actual);
      } catch {
        return false;
      }
    }
    case "exists":
      return actual.trim().length > 0;
    case "not_exists":
      return actual.trim().length === 0;
    default:
      return false;
  }
}

export function evaluateCondition(condition: Condition, ctx: MatchContext): boolean {
  const values = fieldValues(condition.field, ctx);
  const caseSensitive = condition.caseSensitive === true;

  if (condition.op === "domain_in" || condition.op === "domain_not_in") {
    const domains = (condition.values || (condition.value || "").split(","))
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
    const actualDomains =
      condition.field.toLowerCase() === "from"
        ? [addressDomain(ctx.from)]
        : values.map(addressDomain).filter(Boolean);
    const found = actualDomains.some((d) => domains.includes(d));
    return condition.op === "domain_in" ? found : !found;
  }

  if (condition.op === "exists" || condition.op === "not_exists") {
    const exists = values.some((v) => v.trim().length > 0);
    return condition.op === "exists" ? exists : !exists;
  }

  const expected = condition.value ?? "";
  return values.some((actual) => textMatch(actual || "", condition.op, expected, caseSensitive));
}

export function matchesRule(match: RuleMatch, ctx: MatchContext): boolean {
  if (match.matchAll) return true;

  const all = match.all || [];
  const any = match.any || [];
  if (!all.length && !any.length) return false;

  if (all.length && !all.every((condition) => evaluateCondition(condition, ctx))) return false;
  if (any.length && !any.some((condition) => evaluateCondition(condition, ctx))) return false;
  return true;
}

export function parseRuleMatch(json: string): RuleMatch {
  try {
    return ruleMatchSchema.parse(JSON.parse(json));
  } catch {
    return {};
  }
}

export function parseRuleGuards(json: string): RuleGuards {
  try {
    return ruleGuardsSchema.parse(JSON.parse(json));
  } catch {
    return {};
  }
}

export function parseRuleAction(json: string): RuleAction | null {
  try {
    return ruleActionSchema.parse(JSON.parse(json));
  } catch {
    return null;
  }
}
