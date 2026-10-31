import { describe, expect, it } from "vitest";
import {
  normalizeReplySubject,
  quoteBody,
  renderTemplate,
  renderSubject,
} from "../src/worker/services/template";

describe("template rendering", () => {
  it("replaces variables and escapes HTML", () => {
    const result = renderTemplate(
      {
        subject_tpl: "Re: {{subject}}",
        text_tpl: "Hello {{sender_name}}",
        html_tpl: "<p>Hello {{sender_name}}</p>",
      },
      { subject: "Quote", sender_name: "<b>Alice</b>" },
    );
    expect(result.subject).toBe("Re: Quote");
    expect(result.text).toBe("Hello <b>Alice</b>");
    expect(result.html).toBe("<p>Hello &lt;b&gt;Alice&lt;/b&gt;</p>");
  });

  it("renders conditional blocks", () => {
    const result = renderTemplate(
      {
        subject_tpl: "Re: {{subject}}",
        text_tpl: "Hi{{#if ai_text}} {{ai_text}}{{/if}}",
      },
      { subject: "x", ai_text: "" },
    );
    expect(result.text).toBe("Hi");
  });

  it("converts newlines to <br> for AI text in HTML", () => {
    const result = renderTemplate(
      {
        subject_tpl: "Re: {{subject}}",
        text_tpl: "{{ai_text}}",
        html_tpl: "<div>{{ai_text}}</div>",
      },
      { subject: "x", ai_text: "line1\nline2" },
    );
    expect(result.html).toBe("<div>line1<br />line2</div>");
  });

  it("strips newlines from the subject", () => {
    expect(renderSubject("{{subject}}", { subject: "a\nb" })).toBe("a b");
  });

  it("quotes body lines", () => {
    expect(quoteBody("a\nb")).toBe("> a\n> b");
  });

  it("normalizes reply subjects", () => {
    expect(normalizeReplySubject("Hello")).toBe("Re: Hello");
    expect(normalizeReplySubject("Re: Hello")).toBe("Re: Hello");
    expect(normalizeReplySubject("RE: Hello")).toBe("RE: Hello");
    expect(normalizeReplySubject("")).toBe("Re:");
  });
});
