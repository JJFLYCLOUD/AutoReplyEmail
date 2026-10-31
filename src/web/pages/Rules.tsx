import { useMemo, useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks";
import type { Mailbox, Rule, Template } from "../types";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
} from "../ui";

interface RuleForm {
  mailboxId: string;
  name: string;
  priority: string;
  enabled: boolean;
  keywords: string;
  matchMode: "any" | "all";
  matchAll: boolean;
  advancedMatch: string;
  templateId: string;
  aiMode: "off" | "polish" | "classify";
  delaySeconds: string;
  cooldownHours: string;
  maxPerThread: string;
  maxPerDay: string;
}

const emptyForm: RuleForm = {
  mailboxId: "",
  name: "",
  priority: "100",
  enabled: true,
  keywords: "",
  matchMode: "any",
  matchAll: false,
  advancedMatch: "",
  templateId: "",
  aiMode: "off",
  delaySeconds: "0",
  cooldownHours: "24",
  maxPerThread: "1",
  maxPerDay: "50",
};

function parseKeywords(rule: Rule): string {
  try {
    const match = JSON.parse(rule.match_json || "{}") as {
      all?: Array<{ field: string; op: string; value?: string }>;
      any?: Array<{ field: string; op: string; value?: string }>;
    };
    const list = match.any || match.all || [];
    return [...new Set(list.filter((item) => item.op === "contains").map((item) => item.value || ""))]
      .filter(Boolean)
      .join(", ");
  } catch {
    return "";
  }
}

function formFromRule(rule: Rule): RuleForm {
  let match: Record<string, unknown> = {};
  let action: Record<string, unknown> = {};
  let guards: Record<string, unknown> = {};
  try {
    match = JSON.parse(rule.match_json || "{}");
  } catch {
    // ignore
  }
  try {
    action = JSON.parse(rule.action_json || "{}");
  } catch {
    // ignore
  }
  try {
    guards = JSON.parse(rule.guards_json || "{}");
  } catch {
    // ignore
  }
  const ai = (action.ai || {}) as { mode?: string };
  return {
    ...emptyForm,
    mailboxId: rule.mailbox_id,
    name: rule.name,
    priority: String(rule.priority),
    enabled: Boolean(rule.enabled),
    keywords: parseKeywords(rule),
    matchMode: Array.isArray(match.any) ? "any" : "all",
    matchAll: Boolean(match.matchAll),
    advancedMatch: "",
    templateId: String(action.templateId || ""),
    aiMode: (ai.mode as RuleForm["aiMode"]) || "off",
    delaySeconds: String(action.delaySeconds || 0),
    cooldownHours: String(guards.cooldownHours ?? 24),
    maxPerThread: String(guards.maxPerThread ?? 1),
    maxPerDay: String(guards.maxPerDay ?? 50),
  };
}

export default function RulesPage() {
  const mailboxes = useApi<{ items: Mailbox[] }>("/mailboxes");
  const templates = useApi<{ items: Template[] }>("/templates");
  const [mailboxFilter, setMailboxFilter] = useState("");
  const rules = useApi<{ items: Rule[] }>(
    mailboxFilter ? `/rules?mailboxId=${encodeURIComponent(mailboxFilter)}` : "/rules",
  );

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [form, setForm] = useState<RuleForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mailboxList = mailboxes.data?.items || [];
  const templateList = templates.data?.items || [];
  const selectedTemplates = templateList.filter((item) => item.mailbox_id === form.mailboxId);
  const mailboxMap = useMemo(
    () => new Map(mailboxList.map((item) => [item.id, item])),
    [mailboxList],
  );
  const templateMap = useMemo(
    () => new Map(templateList.map((item) => [item.id, item])),
    [templateList],
  );

  function update<K extends keyof RuleForm>(key: K, value: RuleForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function openCreate() {
    setEditing(null);
    const mailboxId = mailboxFilter || mailboxList[0]?.id || "";
    const firstTemplate = templateList.find((item) => item.mailbox_id === mailboxId);
    setForm({ ...emptyForm, mailboxId, templateId: firstTemplate?.id || "" });
    setFormError(null);
    setOpen(true);
  }

  function openEdit(rule: Rule) {
    setEditing(rule);
    setForm(formFromRule(rule));
    setFormError(null);
    setOpen(true);
  }

  function buildPayload() {
    let match: Record<string, unknown> = {};
    if (form.advancedMatch.trim()) {
      match = JSON.parse(form.advancedMatch);
    } else if (form.matchAll) {
      match = { matchAll: true };
    } else {
      const keywords = form.keywords
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
      if (!keywords.length) throw new Error("请至少填写一个关键词，或选择“匹配所有邮件”");
      const conditions = keywords.flatMap((keyword) => [
        { field: "subject", op: "contains", value: keyword },
        { field: "body", op: "contains", value: keyword },
      ]);
      match = form.matchMode === "any" ? { any: conditions } : { all: conditions };
    }

    if (!form.templateId) throw new Error("请选择回复模板");

    return {
      mailboxId: form.mailboxId,
      name: form.name.trim(),
      priority: Number(form.priority) || 100,
      enabled: form.enabled,
      match,
      guards: {
        cooldownHours: Number(form.cooldownHours) || 0,
        maxPerThread: Number(form.maxPerThread) || 1,
        maxPerDay: Number(form.maxPerDay) || 50,
      },
      action: {
        type: "reply",
        templateId: form.templateId,
        ai: { mode: form.aiMode },
        delaySeconds: Number(form.delaySeconds) || 0,
      },
    };
  }

  async function save() {
    setSaving(true);
    setFormError(null);
    try {
      const payload = buildPayload();
      if (editing) await api.patch(`/rules/${editing.id}`, payload);
      else await api.post("/rules", payload);
      setOpen(false);
      setNotice(editing ? "规则已更新" : "规则已创建");
      rules.reload();
    } catch (err) {
      setFormError(String(err instanceof Error ? err.message : err));
    } finally {
      setSaving(false);
    }
  }

  async function toggle(rule: Rule) {
    try {
      await api.patch(`/rules/${rule.id}`, { enabled: !rule.enabled });
      rules.reload();
    } catch (err) {
      alert(String(err instanceof Error ? err.message : err));
    }
  }

  async function remove(rule: Rule) {
    if (!window.confirm(`删除规则 ${rule.name}？`)) return;
    try {
      await api.del(`/rules/${rule.id}`);
      rules.reload();
    } catch (err) {
      alert(String(err instanceof Error ? err.message : err));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Select
            className="w-52"
            value={mailboxFilter}
            onChange={(event) => setMailboxFilter(event.target.value)}
          >
            <option value="">全部邮箱</option>
            {mailboxList.map((mailbox) => (
              <option key={mailbox.id} value={mailbox.id}>
                {mailbox.address}
              </option>
            ))}
          </Select>
          <Button variant="outline" size="sm" onClick={rules.reload}>
            刷新
          </Button>
        </div>
        <Button size="sm" onClick={openCreate} disabled={!mailboxList.length}>
          新建规则
        </Button>
      </div>

      {notice ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          {notice}
        </div>
      ) : null}
      {rules.error ? <ErrorBox message={rules.error} /> : null}
      {rules.loading && !rules.data ? <Spinner /> : null}

      {!mailboxes.loading && mailboxList.length === 0 ? (
        <EmptyState title="请先添加邮箱" description="规则需要绑定到一个邮箱。" />
      ) : null}

      {!rules.loading && mailboxList.length > 0 && (rules.data?.items.length || 0) === 0 ? (
        <EmptyState
          title="还没有规则"
          description="例如：主题或正文包含“报价”时回复报价模板。"
          action={<Button onClick={openCreate}>创建第一条规则</Button>}
        />
      ) : null}

      <div className="space-y-2">
        {(rules.data?.items || []).map((rule) => {
          const template = templateMap.get(
            (() => {
              try {
                return JSON.parse(rule.action_json || "{}").templateId;
              } catch {
                return "";
              }
            })(),
          );
          const mailbox = mailboxMap.get(rule.mailbox_id);
          return (
            <Card key={rule.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-slate-800">{rule.name}</span>
                  <Badge tone={rule.enabled ? "green" : "slate"}>
                    {rule.enabled ? "启用" : "停用"}
                  </Badge>
                  <Badge tone="indigo">优先级 {rule.priority}</Badge>
                  {template ? <Badge tone="blue">模板：{template.name}</Badge> : null}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
                  <span>{mailbox?.address || rule.mailbox_id}</span>
                  <span className="truncate">关键词：{parseKeywords(rule) || "自定义 JSON"}</span>
                  <span>
                    AI：
                    {(() => {
                      try {
                        return JSON.parse(rule.action_json || "{}").ai?.mode || "off";
                      } catch {
                        return "off";
                      }
                    })()}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="outline" size="sm" onClick={() => openEdit(rule)}>
                  编辑
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void toggle(rule)}>
                  {rule.enabled ? "停用" : "启用"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void remove(rule)}>
                  删除
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      <Modal
        open={open}
        title={editing ? `编辑规则：${editing.name}` : "新建规则"}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
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
            <Field label="邮箱">
              <Select
                value={form.mailboxId}
                onChange={(event) => {
                  const mailboxId = event.target.value;
                  const first = templateList.find((item) => item.mailbox_id === mailboxId);
                  setForm((current) => ({
                    ...current,
                    mailboxId,
                    templateId: first?.id || "",
                  }));
                }}
              >
                <option value="">选择邮箱</option>
                {mailboxList.map((mailbox) => (
                  <option key={mailbox.id} value={mailbox.id}>
                    {mailbox.address}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="规则名称">
              <Input
                value={form.name}
                onChange={(event) => update("name", event.target.value)}
                placeholder="报价咨询自动回复"
              />
            </Field>
            <Field label="优先级" hint="数字越小越先匹配">
              <Input
                value={form.priority}
                onChange={(event) => update("priority", event.target.value)}
              />
            </Field>
            <label className="flex items-center gap-2 pt-5 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => update("enabled", event.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              启用规则
            </label>
          </div>

          <section className="space-y-3 rounded-lg border border-slate-200 p-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">匹配条件</h4>
            <Field label="关键词" hint="用逗号或换行分隔；会同时匹配主题和正文">
              <Input
                value={form.keywords}
                onChange={(event) => update("keywords", event.target.value)}
                placeholder="报价, 价格, price"
                disabled={form.matchAll || Boolean(form.advancedMatch.trim())}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="关键词关系">
                <Select
                  value={form.matchMode}
                  onChange={(event) => update("matchMode", event.target.value as "any" | "all")}
                  disabled={form.matchAll}
                >
                  <option value="any">任一命中</option>
                  <option value="all">全部命中</option>
                </Select>
              </Field>
              <label className="flex items-center gap-2 pt-5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={form.matchAll}
                  onChange={(event) => {
                    update("matchAll", event.target.checked);
                    if (event.target.checked) update("advancedMatch", "");
                  }}
                  className="h-4 w-4 rounded border-slate-300"
                />
                匹配所有邮件（谨慎）
              </label>
            </div>
            <Field label="高级条件 JSON（可选）" hint="填写后会覆盖上面的关键词条件，格式：{ any: [{ field, op, value }] }">
              <Textarea
                rows={3}
                value={form.advancedMatch}
                onChange={(event) => update("advancedMatch", event.target.value)}
                placeholder='{"any":[{"field":"from","op":"domain_in","values":["example.com"]}]}'
              />
            </Field>
          </section>

          <section className="space-y-3 rounded-lg border border-slate-200 p-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">回复动作</h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="使用模板">
                <Select
                  value={form.templateId}
                  onChange={(event) => update("templateId", event.target.value)}
                >
                  <option value="">选择模板</option>
                  {selectedTemplates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}（{template.locale}）
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="AI 模式">
                <Select
                  value={form.aiMode}
                  onChange={(event) => update("aiMode", event.target.value as RuleForm["aiMode"])}
                >
                  <option value="off">关闭（只用模板）</option>
                  <option value="polish">AI 润色</option>
                  <option value="classify">AI 选择模板</option>
                </Select>
              </Field>
              <Field label="延迟发送（秒）" hint="Cloudflare 原生回复只能即时发送；延迟需配置 SMTP/API">
                <Input
                  value={form.delaySeconds}
                  onChange={(event) => update("delaySeconds", event.target.value)}
                />
              </Field>
              <Field label="同一发件人冷却（小时）">
                <Input
                  value={form.cooldownHours}
                  onChange={(event) => update("cooldownHours", event.target.value)}
                />
              </Field>
              <Field label="同一会话最多回复次数">
                <Input
                  value={form.maxPerThread}
                  onChange={(event) => update("maxPerThread", event.target.value)}
                />
              </Field>
              <Field label="每日最多回复次数">
                <Input
                  value={form.maxPerDay}
                  onChange={(event) => update("maxPerDay", event.target.value)}
                />
              </Field>
            </div>
            {!selectedTemplates.length ? (
              <p className="text-[11px] text-amber-600">
                该邮箱还没有模板，请先到“模板”页面创建。
              </p>
            ) : null}
          </section>
        </div>
      </Modal>
    </div>
  );
}
