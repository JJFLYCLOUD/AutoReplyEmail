import { useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks";
import type { Template } from "../types";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  Modal,
  Spinner,
  Textarea,
} from "../ui";

interface TemplateForm {
  name: string;
  locale: string;
  subjectTpl: string;
  textTpl: string;
  htmlTpl: string;
}

const DEFAULT_TEXT = `您好 {{sender_name}}：

感谢您的来信，我们已收到关于「{{subject}}」的咨询，会尽快给您回复。

此致
{{mailbox_name}}`;

const DEFAULT_HTML = `<p>您好 {{sender_name}}：</p>
<p>感谢您的来信，我们已收到关于「{{subject}}」的咨询，会尽快给您回复。</p>
<p>此致<br />{{mailbox_name}}</p>`;

const emptyForm: TemplateForm = {
  name: "",
  locale: "zh-CN",
  subjectTpl: "Re: {{subject}}",
  textTpl: DEFAULT_TEXT,
  htmlTpl: DEFAULT_HTML,
};

function formFromTemplate(template: Template): TemplateForm {
  return {
    name: template.name,
    locale: template.locale,
    subjectTpl: template.subject_tpl,
    textTpl: template.text_tpl,
    htmlTpl: template.html_tpl || "",
  };
}

function previewVars(form: TemplateForm): Record<string, string> {
  return {
    sender_name: "张三",
    sender_email: "sender@example.com",
    subject: "产品报价咨询",
    original_subject: "产品报价咨询",
    date: new Date().toLocaleString(),
    mailbox: "support@example.com",
    mailbox_name: "Support Team",
    quoted_body: "> 你好，我想了解产品报价。",
    ai_text: "感谢您的咨询，我们会在 1 个工作日内回复您。",
  };
}

function simpleRender(value: string, vars: Record<string, string>): string {
  const withConditionals = value.replace(
    /\{\{#if\s+([a-zA-Z0-9_.]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_all, key: string, body: string) => (vars[key]?.trim() ? body : ""),
  );
  return withConditionals.replace(
    /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g,
    (_all, key: string) => vars[key] ?? "",
  );
}

export default function TemplatesPage() {
  const templates = useApi<{ items: Template[] }>("/templates");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [form, setForm] = useState<TemplateForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ subject: string; text: string; html: string } | null>(null);

  const items = templates.data?.items || [];

  function update<K extends keyof TemplateForm>(key: K, value: TemplateForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setFormError(null);
    setPreview(null);
    setOpen(true);
  }

  function openEdit(template: Template) {
    setEditing(template);
    setForm(formFromTemplate(template));
    setFormError(null);
    setPreview(null);
    setOpen(true);
  }

  async function save() {
    setSaving(true);
    setFormError(null);
    try {
      if (!form.name.trim()) throw new Error("请填写模板名称");
      if (!form.subjectTpl.trim()) throw new Error("请填写邮件主题");
      if (!form.textTpl.trim()) throw new Error("请填写纯文本正文");
      if (editing) {
        await api.patch(`/templates/${editing.id}`, {
          name: form.name,
          locale: form.locale,
          subjectTpl: form.subjectTpl,
          textTpl: form.textTpl,
          htmlTpl: form.htmlTpl || null,
        });
      } else {
        await api.post("/templates", {
          name: form.name,
          locale: form.locale,
          subjectTpl: form.subjectTpl,
          textTpl: form.textTpl,
          htmlTpl: form.htmlTpl || null,
        });
      }
      setOpen(false);
      setNotice(editing ? "模板已更新" : "模板已创建");
      templates.reload();
    } catch (err) {
      setFormError(String(err instanceof Error ? err.message : err));
    } finally {
      setSaving(false);
    }
  }

  async function runPreview() {
    if (editing) {
      try {
        const result = await api.post<{ subject: string; text: string; html: string }>(
          `/templates/${editing.id}/preview`,
          {
            template: {
              subjectTpl: form.subjectTpl,
              textTpl: form.textTpl,
              htmlTpl: form.htmlTpl,
            },
          },
        );
        setPreview(result);
        return;
      } catch {
        // fall back to client-side preview
      }
    }
    const vars = previewVars(form);
    setPreview({
      subject: simpleRender(form.subjectTpl, vars),
      text: simpleRender(form.textTpl, vars),
      html: simpleRender(form.htmlTpl, vars),
    });
  }

  async function remove(template: Template) {
    if (!window.confirm(`删除模板 ${template.name}？引用它的规则将无法回复。`)) return;
    try {
      await api.del(`/templates/${template.id}`);
      templates.reload();
    } catch (err) {
      alert(String(err instanceof Error ? err.message : err));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={templates.reload}>
            刷新
          </Button>
        </div>
        <Button size="sm" onClick={openCreate}>
          新建模板
        </Button>
      </div>

      {notice ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          {notice}
        </div>
      ) : null}
      {templates.error ? <ErrorBox message={templates.error} /> : null}
      {templates.loading && !templates.data ? <Spinner /> : null}

      {!templates.loading && items.length === 0 ? (
        <EmptyState
          title="还没有模板"
          description="模板是全局的，所有邮箱的规则都可以使用。"
          action={<Button onClick={openCreate}>创建第一个模板</Button>}
        />
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        {items.map((template) => (
          <Card key={template.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-800">{template.name}</h3>
                  <Badge tone="indigo">{template.locale}</Badge>
                  <Badge tone="green">全局</Badge>
                </div>
              </div>
              <div className="flex gap-1">
                <Button variant="outline" size="sm" onClick={() => openEdit(template)}>
                  编辑
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void remove(template)}>
                  删除
                </Button>
              </div>
            </div>
            <div className="mt-2 rounded-lg bg-slate-50 p-2.5">
              <div className="text-[11px] font-medium text-slate-700">
                {template.subject_tpl}
              </div>
              <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-[11px] leading-5 text-slate-500">
                {template.text_tpl}
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Modal
        open={open}
        title={editing ? `编辑模板：${editing.name}` : "新建回复模板"}
        onClose={() => setOpen(false)}
        width="max-w-4xl"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button variant="secondary" onClick={() => void runPreview()}>
              预览
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {formError ? <ErrorBox message={formError} /> : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="模板名称">
              <Input
                value={form.name}
                onChange={(event) => update("name", event.target.value)}
                placeholder="报价咨询回复"
              />
            </Field>
            <Field label="语言">
              <Input value={form.locale} onChange={(event) => update("locale", event.target.value)} />
            </Field>
          </div>

          <Field label="邮件主题">
            <Input
              value={form.subjectTpl}
              onChange={(event) => update("subjectTpl", event.target.value)}
              placeholder="Re: {{subject}}"
            />
          </Field>

          <div className="grid gap-3 lg:grid-cols-2">
            <Field label="纯文本正文">
              <Textarea
                rows={12}
                value={form.textTpl}
                onChange={(event) => update("textTpl", event.target.value)}
              />
            </Field>
            <Field label="HTML 正文（可选）">
              <Textarea
                rows={12}
                value={form.htmlTpl}
                onChange={(event) => update("htmlTpl", event.target.value)}
              />
            </Field>
          </div>

          <div className="rounded-lg bg-slate-50 p-3 text-[11px] leading-5 text-slate-500">
            可用变量：
            <code className="mx-1">{`{{sender_name}}`}</code>
            <code className="mx-1">{`{{sender_email}}`}</code>
            <code className="mx-1">{`{{subject}}`}</code>
            <code className="mx-1">{`{{date}}`}</code>
            <code className="mx-1">{`{{mailbox}}`}</code>
            <code className="mx-1">{`{{mailbox_name}}`}</code>
            <code className="mx-1">{`{{quoted_body}}`}</code>
            <code className="mx-1">{`{{ai_text}}`}</code>
            ，条件块：<code className="mx-1">{`{{#if ai_text}}...{{/if}}`}</code>
          </div>

          {preview ? (
            <div className="space-y-2 rounded-lg border border-slate-200 p-3">
              <div className="text-xs font-medium text-slate-700">主题：{preview.subject}</div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[11px] text-slate-600 scrollbar-thin">
                {preview.text}
              </pre>
              {preview.html ? (
                <iframe
                  title="模板 HTML 预览"
                  sandbox=""
                  srcDoc={preview.html}
                  className="h-48 w-full rounded border border-slate-200 bg-white"
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
