import { headerValue, isMultipartReport } from "../lib/mime-lite";
import { normalizeAddress } from "../lib/util";

export interface GuardOptions {
  skipAutoSubmitted: boolean;
  skipBulk: boolean;
  skipNoReply: boolean;
  skipBounces: boolean;
  maxReferences: number;
  allowSelf: boolean;
}

export const DEFAULT_GUARD_OPTIONS: GuardOptions = {
  skipAutoSubmitted: true,
  skipBulk: true,
  skipNoReply: true,
  skipBounces: true,
  maxReferences: 100,
  allowSelf: false,
};

export interface GuardContext {
  mailboxAddress: string;
  from: string;
  headers: Record<string, string>;
  text: string;
  referencesCount: number;
  contentType: string;
}

export interface GuardResult {
  allowed: boolean;
  code?: string;
  reason?: string;
}

const BOUNCE_SUBJECTS = [
  "undeliverable",
  "delivery status notification",
  "mail delivery failed",
  "returned mail",
  "failure notice",
  "退信",
  "投递失败",
  "自动回复",
  "auto-reply",
  "automatic reply",
  "out of office",
  "out of the office",
];

const NO_REPLY_LOCAL = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?|notify)$/i;

export function evaluateStaticGuards(
  ctx: GuardContext,
  options: GuardOptions = DEFAULT_GUARD_OPTIONS,
): GuardResult {
  const from = normalizeAddress(ctx.from);
  if (!from || from.length > 320 || !/^[^\s@<>]+@[^\s@<>]+$/.test(from)) {
    return { allowed: false, code: "missing_from", reason: "缺少有效发件人" };
  }

  if (!options.allowSelf && from === normalizeAddress(ctx.mailboxAddress)) {
    return { allowed: false, code: "self", reason: "发件人是邮箱自身" };
  }

  const autoSubmitted = headerValue(ctx.headers, "auto-submitted").trim().toLowerCase();
  if (options.skipAutoSubmitted && autoSubmitted && autoSubmitted !== "no") {
    return { allowed: false, code: "auto_submitted", reason: `Auto-Submitted: ${autoSubmitted}` };
  }

  const precedence = headerValue(ctx.headers, "precedence").trim().toLowerCase();
  if (options.skipBulk && ["bulk", "list", "junk"].includes(precedence)) {
    return { allowed: false, code: "bulk", reason: `Precedence: ${precedence}` };
  }

  if (options.skipBulk) {
    const listHeaders = ["list-id", "list-unsubscribe", "list-post", "list-help"];
    const listHeader = listHeaders.find((name) => headerValue(ctx.headers, name));
    if (listHeader) {
      return { allowed: false, code: "list", reason: `邮件列表头: ${listHeader}` };
    }
  }

  if (headerValue(ctx.headers, "x-auto-response-suppress").trim()) {
    return { allowed: false, code: "auto_suppress", reason: "X-Auto-Response-Suppress" };
  }

  const loopHeader = headerValue(ctx.headers, "x-loop");
  if (loopHeader && loopHeader.toLowerCase().includes(normalizeAddress(ctx.mailboxAddress))) {
    return { allowed: false, code: "loop_header", reason: "X-Loop 包含本邮箱" };
  }

  if (options.skipBounces) {
    const returnPath = headerValue(ctx.headers, "return-path").trim();
    if (returnPath === "<>" || returnPath === "") {
      if (returnPath === "<>") {
        return { allowed: false, code: "bounce", reason: "Return-Path 为空（退信）" };
      }
    }
    if (isMultipartReport(ctx.contentType)) {
      return { allowed: false, code: "bounce", reason: "multipart/report（退信/回执）" };
    }
    const subject = headerValue(ctx.headers, "subject").toLowerCase();
    const hit = BOUNCE_SUBJECTS.find((word) => subject.includes(word));
    if (hit) {
      return { allowed: false, code: "bounce_subject", reason: `主题包含 ${hit}` };
    }
  }

  if (options.skipNoReply) {
    const local = from.split("@")[0] || "";
    if (NO_REPLY_LOCAL.test(local)) {
      return { allowed: false, code: "no_reply", reason: `发件人不可回复: ${from}` };
    }
  }

  if (ctx.referencesCount > options.maxReferences) {
    return {
      allowed: false,
      code: "references",
      reason: `References 超过 ${options.maxReferences} 条`,
    };
  }

  return { allowed: true };
}

export function mergeGuardOptions(input: Partial<GuardOptions> | undefined): GuardOptions {
  return { ...DEFAULT_GUARD_OPTIONS, ...(input || {}) };
}
