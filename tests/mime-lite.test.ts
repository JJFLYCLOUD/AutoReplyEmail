import { describe, expect, it } from "vitest";
import {
  buildReferences,
  buildThreadKey,
  decodeMimeWords,
  decodeQuotedPrintable,
  extractTextFromRaw,
  normalizeSubject,
  parseAddress,
  parseAddressList,
  parseHeaderBlock,
  referenceIds,
} from "../src/worker/lib/mime-lite";

describe("mime-lite", () => {
  it("parses folded headers", () => {
    const headers = parseHeaderBlock(
      "Subject: Hello\r\n World\r\nFrom: Alice <alice@example.com>\r\nTo: a@example.com, b@example.com\r\n",
    );
    expect(headers.subject).toBe("Hello World");
    expect(headers.from).toBe("Alice <alice@example.com>");
  });

  it("decodes RFC 2047 words", () => {
    expect(decodeMimeWords("=?UTF-8?B?5L2g5aW9?=")).toBe("你好");
    expect(decodeMimeWords("=?UTF-8?Q?Hello_World?=")).toBe("Hello World");
  });

  it("decodes quoted printable", () => {
    expect(decodeQuotedPrintable("Hello=20World=0A!")).toBe("Hello World\n!");
  });

  it("extracts text from a plain message", () => {
    const raw = "From: a@b.com\r\nSubject: Hi\r\nContent-Type: text/plain\r\n\r\nHello there";
    expect(extractTextFromRaw(raw)).toBe("Hello there");
  });

  it("extracts and strips HTML", () => {
    const raw =
      "Content-Type: text/html\r\n\r\n<html><body><p>Hello <b>World</b></p></body></html>";
    expect(extractTextFromRaw(raw)).toBe("Hello World");
  });

  it("decodes base64 inside multipart/alternative", () => {
    const textBase64 =
      "5pyA5paw5Zyw5Z2ACuWFs+mUruivje+8muaKpeS7twror7flm57lpI0=";
    const htmlBase64 =
      "PGh0bWw+PGJvZHk+PHA+5pyA5paw5Zyw5Z2APC9wPjxwPuWFs+mUruivje+8muaKpeS7tzwvcD48L2JvZHk+PC9odG1sPg==";
    const raw = [
      'Content-Type: multipart/alternative; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      textBase64,
      "--b1",
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      htmlBase64,
      "--b1--",
      "",
    ].join("\r\n");

    const text = extractTextFromRaw(raw);
    expect(text).toContain("最新地址");
    expect(text).toContain("关键词");
    expect(text).toContain("报价");
  });

  it("falls back to HTML when there is no text/plain part", () => {
    const htmlBase64 =
      "PGh0bWw+PGJvZHk+PHA+5pyA5paw5Zyw5Z2APC9wPjwvYm9keT48L2h0bWw+";
    const raw = [
      'Content-Type: multipart/alternative; boundary="b2"',
      "",
      "--b2",
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      htmlBase64,
      "--b2--",
      "",
    ].join("\r\n");
    expect(extractTextFromRaw(raw)).toContain("最新地址");
  });

  it("decodes truncated base64 parts", () => {
    const truncated = "5pyA5paw5Zyw5Z2ACuWFs+mUruivje+8muaKpeS7twror7flm57lpI0=".slice(0, -8);
    const raw = [
      'Content-Type: multipart/alternative; boundary="b3"',
      "",
      "--b3",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      truncated,
      "--b3--",
      "",
    ].join("\r\n");
    expect(extractTextFromRaw(raw)).toContain("最新地址");
  });

  it("handles nested multipart messages", () => {
    const textBase64 = "5pyA5paw5Zyw5Z2A";
    const raw = [
      'Content-Type: multipart/mixed; boundary="outer"',
      "",
      "--outer",
      'Content-Type: multipart/alternative; boundary="inner"',
      "",
      "--inner",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      textBase64,
      "--inner--",
      "",
      "--outer--",
      "",
    ].join("\r\n");
    expect(extractTextFromRaw(raw)).toContain("最新地址");
  });

  it("parses addresses", () => {
    expect(parseAddress('"Alice" <Alice@Example.com>')).toEqual({
      name: "Alice",
      email: "alice@example.com",
    });
    expect(parseAddressList("a@example.com, Bob <b@example.com>")).toHaveLength(2);
  });

  it("normalizes subjects", () => {
    expect(normalizeSubject("Re: Re: Hello")).toBe("hello");
    expect(normalizeSubject("Fwd: 回复: Hello")).toBe("hello");
  });

  it("builds references and thread keys", () => {
    const refs = referenceIds("<a@x> <b@x>");
    expect(refs).toEqual(["<a@x>", "<b@x>"]);
    expect(buildThreadKey({ references: "<a@x> <b@x>", messageId: "<c@x>" })).toBe("<a@x>");
    expect(buildThreadKey({ messageId: "<c@x>" })).toBe("<c@x>");
    expect(buildThreadKey({ subject: "Re: Hello" })).toBe("subject:hello");
    expect(buildReferences("<a@x>", "<b@x>")).toEqual(["<a@x>", "<b@x>"]);
  });
});
