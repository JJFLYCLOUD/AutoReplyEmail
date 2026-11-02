import { describe, expect, it } from "vitest";
import { normalizeMessageId } from "../src/worker/lib/mime-lite";
import { buildReplyThread } from "../src/worker/lib/reply-thread";

describe("buildReplyThread", () => {
  it("starts a new conversation when replyAsNew is enabled", () => {
    const thread = buildReplyThread({
      replyAsNew: true,
      inboundMessageId: "<inbound@example.com>",
      inboundReferences: "<older@example.com>",
      inboundSubject: "产品报价",
      templateSubject: "自动回复：产品报价",
    });

    expect(thread.subject).toBe("自动回复：产品报价");
    expect(thread.inReplyTo).toBeNull();
    expect(thread.references).toEqual([]);
  });

  it("threads a first inbound message", () => {
    const thread = buildReplyThread({
      replyAsNew: false,
      inboundMessageId: "<inbound@example.com>",
      inboundReferences: "",
      inboundSubject: "产品报价",
      templateSubject: "Re: 产品报价",
    });

    expect(thread.subject).toBe("Re: 产品报价");
    expect(thread.inReplyTo).toBe("<inbound@example.com>");
    expect(thread.references).toEqual(["<inbound@example.com>"]);
  });

  it("keeps the previous references and appends the current message", () => {
    const thread = buildReplyThread({
      replyAsNew: false,
      inboundMessageId: "<inbound@example.com>",
      inboundReferences: "<p1@example.com> <p2@example.com>",
      inboundSubject: "Re: 产品报价",
      templateSubject: "Re: {{subject}}",
    });

    expect(thread.inReplyTo).toBe("<inbound@example.com>");
    expect(thread.references).toEqual([
      "<p1@example.com>",
      "<p2@example.com>",
      "<inbound@example.com>",
    ]);
  });

  it("does not duplicate the current message id in references", () => {
    const thread = buildReplyThread({
      replyAsNew: false,
      inboundMessageId: "<inbound@example.com>",
      inboundReferences: "<older@example.com> <inbound@example.com>",
      inboundSubject: "Hello",
      templateSubject: "Re: Hello",
    });

    expect(thread.references).toEqual([
      "<older@example.com>",
      "<inbound@example.com>",
    ]);
  });

  it("forces the original subject when the template changes it", () => {
    const thread = buildReplyThread({
      replyAsNew: false,
      inboundMessageId: "<inbound@example.com>",
      inboundReferences: "",
      inboundSubject: "产品报价",
      templateSubject: "自动回复：产品报价",
    });

    expect(thread.subject).toBe("Re: 产品报价");
  });

  it("adds a Re prefix when the template matches but has no prefix", () => {
    const thread = buildReplyThread({
      replyAsNew: false,
      inboundMessageId: "<inbound@example.com>",
      inboundReferences: "",
      inboundSubject: "Hello",
      templateSubject: "Hello",
    });

    expect(thread.subject).toBe("Re: Hello");
  });

  it("wraps bare message ids in angle brackets", () => {
    expect(normalizeMessageId("bare@example.com")).toBe("<bare@example.com>");
    expect(normalizeMessageId("<already@example.com>")).toBe("<already@example.com>");
  });
});
