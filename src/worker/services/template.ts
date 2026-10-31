import { escapeHtml } from "../lib/util";

export type RenderVars = Record<string, string>;

function truthy(value: string | undefined): boolean {
  return Boolean(value && value.trim());
}

function replaceConditionals(template: string, vars: RenderVars): string {
  return template.replace(
    /\{\{#if\s+([a-zA-Z0-9_.]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_all, key: string, body: string) => (truthy(vars[key]) ? body : ""),
  );
}

function applyVars(template: string, vars: RenderVars, mode: "text" | "subject" | "html"): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_all, key: string) => {
    const value = vars[key] ?? "";
    if (mode === "subject") return value.replace(/[\r\n]+/g, " ").slice(0, 900);
    if (mode === "html") {
      const escaped = escapeHtml(value);
      return key === "quoted_body" || key === "ai_text" ? escaped.replace(/\r?\n/g, "<br />") : escaped;
    }
    return value;
  });
}

export function renderText(template: string, vars: RenderVars): string {
  return applyVars(replaceConditionals(template, vars), vars, "text").trim();
}

export function renderSubject(template: string, vars: RenderVars): string {
  return applyVars(replaceConditionals(template, vars), vars, "subject").trim();
}

export function renderHtml(template: string, vars: RenderVars): string {
  return applyVars(replaceConditionals(template, vars), vars, "html").trim();
}

export interface TemplateContent {
  subject_tpl: string;
  text_tpl: string;
  html_tpl?: string | null;
}

export function renderTemplate(
  template: TemplateContent,
  vars: RenderVars,
): { subject: string; text: string; html: string } {
  const subject = renderSubject(template.subject_tpl, vars) || "Re: " + (vars.subject || "");
  const text = renderText(template.text_tpl, vars);
  const html = template.html_tpl
    ? renderHtml(template.html_tpl, vars)
    : text
        .split(/\n{2,}/)
        .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br />")}</p>`)
        .join("\n");
  return { subject, text, html };
}

export function quoteBody(text: string, limit = 4000): string {
  return text
    .slice(0, limit)
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

export function normalizeReplySubject(subject: string | null | undefined): string {
  const value = (subject || "").trim();
  if (!value) return "Re:";
  return /^re\s*:/i.test(value) ? value : `Re: ${value}`;
}
