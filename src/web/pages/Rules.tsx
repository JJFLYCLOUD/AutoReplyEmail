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
  mailboxIds: string[];
  name: string;
  priority: string;
  enabled: boolean;
  keywords: string;
  matchMode: "any" | "all";
  matchAll: boolean;
  advancedMatch: string;
  domainMode: "off" | "allow" | "deny";
  domains: string;
  includeSubdomains: boolean;
  templateId: string;
  replyAsNew: boolean;
  aiMode: "off" | "polish" | "classify";
  delaySeconds: string;
  cooldownHours: string;
  maxPerThread: string;
}

const emptyForm: RuleForm = {
  mailboxIds: [],
  name: "",
  priority: "100",
  enabled: true,
  keywords: "",
  matchMode: "any",
  matchAll: false,
  advancedMatch: "",
  domainMode: "off",
  domains: "",
  includeSubdomains: true,
  templateId: "",
  replyAsNew: false,
  aiMode: "off",
  delaySeconds: "0",
  cooldownHours: "24",
  maxPerThread: "1",
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
  const domainFilter = (match.domainFilter || {}) as {
    mode?: string;
    domains?: string[];
    includeSubdomains?: boolean;
  };
  return {
    ...emptyForm,
    mailboxIds: rule.mailboxIds || [],
    name: rule.name,
    priority: String(rule.priority),
    enabled: Boolean(rule.enabled),
    keywords: parseKeywords(rule),
    matchMode: Array.isArray(match.any) ? "any" : "all",
    matchAll: Boolean(match.matchAll),
    advancedMatch: "",
    domainMode:
      domainFilter.mode === "allow" || domainFilter.mode === "deny"
        ? domainFilter.mode
        : "off",
    domains: Array.isArray(domainFilter.domains) ? domainFilter.domains.join(", ") : "",
    includeSubdomains: domainFilter.includeSubdomains !== false,
    templateId: String(action.templateId || ""),
    replyAsNew: action.replyAsNew === true,
    aiMode: (ai.mode as RuleForm["aiMode"]) || "off",
    delaySeconds: String(action.delaySeconds || 0),
    cooldownHours: String(guards.cooldownHours ?? 24),
    maxPerThread: String(guards.maxPerThread ?? 1),
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
  const sortedRules = [...(rules.data?.items || [])].sort(
    (a, b) => a.priority - b.priority || a.created_at - b.created_at,
  );
  const mailboxMap = useMemo(
    () => new Map(mailboxList.map((item) => [item.id, item])),
    [mailboxList],
  );
  const templateMap = useMemo(
    () => new Map(templateList.map((item) => [item.id, item])),
    [templateList],
  );
  const selectedHasCfReply = mailboxList
    .filter((mailbox) => form.mailboxIds.includes(mailbox.id))
    .some((mailbox) => (mailbox.outbound || []).some((channel) => channel.kind === "cf_reply"));

  function update<K extends keyof RuleForm>(key: K, value: RuleForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function openCreate() {
    setEditing(null);
    setForm({
      ...emptyForm,
      mailboxIds: mailboxFilter
        ? [mailboxFilter]
        : mailboxList.length === 1
          ? [mailboxList[0].id]
          : [],
      templateId: templateList[0]?.id || "",
    });
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
    const domains = form.domains
      .split(/[,，\n]/)
      .map((item) =>
        item
          .trim()
          .toLowerCase()
          .replace(/^@/, "")
          .replace(/^\*\./, "")
          .replace(/\.$/, ""),
      )
      .filter(Boolean);
    if (form.domainMode !== "off" && !domains.length) {
      throw new Error("请填写发件人域名列表");
    }
    const domainFilter = {
      mode: form.domainMode,
      domains: [...new Set(domains)],
      includeSubdomains: form.includeSubdomains,
    };

    let match: Record<string, unknown> = {};
    if (form.advancedMatch.trim()) {
      match = { ...JSON.parse(form.advancedMatch), domainFilter };
    } else if (form.matchAll) {
      match = { matchAll: true, domainFilter };
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
      match = form.matchMode === "any" ? { any: conditions, domainFilter } : { all: conditions, domainFilter };
    }

    if (!form.templateId) throw new Error("请选择回复模板");
    if (!form.mailboxIds.length) throw new Error("请至少选择一个邮箱");

    return {
      mailboxIds: form.mailboxIds,
      name: form.name.trim(),
      priority: Number(form.priority) || 100,
      enabled: form.enabled,
      match,
      guards: {
        cooldownHours: Number(form.cooldownHours) || 0,
        maxPerThread: Number(form.maxPerThread) || 1,
      },
      action: {
        type: "reply",
        templateId: form.templateId,
        replyAsNew: form.replyAsNew,
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
    if (!rule.enabled && rule.mailboxIds.length === 0) {
      alert("请先编辑规则并绑定至少一个邮箱，再启用。");
      return;
    }
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
          <span className="text-[11px] text-slate-400">
            按优先级升序，数字越小越先匹配
          </span>
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
        <EmptyState title="请先添加邮箱" description="规则需要绑定至少一个邮箱。" />
      ) : null}

      {!rules.loading && mailboxList.length > 0 && (rules.data?.items.length || 0) === 0 ? (
        <EmptyState
          title="还没有规则"
          description="例如：主题或正文包含“报价”时回复报价模板。"
          action={<Button onClick={openCreate}>创建第一条规则</Button>}
        />
      ) : null}

      <div className="space-y-2">
        {(sortedRules).map((rule) => {
          const action = (() => {
            try {
              return JSON.parse(rule.action_json || "{}") as {
                templateId?: string;
                ai?: { mode?: string };
                replyAsNew?: boolean;
              };
            } catch {
              return {};
            }
          })();
          const template = templateMap.get(action.templateId || "");
          const replyAsNew = action.replyAsNew === true;
          const mailboxNames = rule.mailboxIds.map(
            (id) => mailboxMap.get(id)?.address || id,
          );
          let domainFilter: { mode?: string; domains?: string[] } = {};
          try {
            domainFilter = JSON.parse(rule.match_json || "{}").domainFilter || {};
          } catch {
            domainFilter = {};
          }
          const domainMode =
            domainFilter.mode === "allow" || domainFilter.mode === "deny"
              ? domainFilter.mode
              : "off";
          const domainList = Array.isArray(domainFilter.domains) ? domainFilter.domains : [];
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
                  {replyAsNew ? <Badge tone="amber">新会话</Badge> : null}
                  {domainMode !== "off" ? (
                    <Badge tone={domainMode === "allow" ? "green" : "red"}>
                      域名{domainMode === "allow" ? "白名单" : "黑名单"}：
                      {domainList.slice(0, 2).join(", ")}
                      {domainList.length > 2 ? "…" : ""}
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
                  <span>
                    {mailboxNames.length
                      ? mailboxNames.join(", ")
                      : "未绑定邮箱（已停用）"}
                  </span>
                  <span className="truncate">关键词：{parseKeywords(rule) || "自定义 JSON"}</span>
                  <span>
                    AI：
                    {action.ai?.mode || "off"}
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

          <div className="space-y-2 rounded-lg border border-slate-200 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-600">绑定邮箱（可多选）</span>
              <div className="flex gap-2 text-[11px]">
                <button
                  type="button"
                  className="text-indigo-600 hover:underline"
                  onClick={() => update("mailboxIds", mailboxList.map((mailbox) => mailbox.id))}
                >
                  全选
                </button>
                <button
                  type="button"
                  className="text-slate-500 hover:underline"
                  onClick={() => update("mailboxIds", [])}
                >
                  清空
                </button>
              </div>
            </div>
            <div className="grid max-h-40 gap-1.5 overflow-y-auto sm:grid-cols-2">
              {mailboxList.map((mailbox) => (
                <label
                  key={mailbox.id}
                  className="flex items-center gap-2 rounded px-1.5 py-1 text-sm text-slate-700 hover:bg-slate-50"
                >
                  <input
                    type="checkbox"
                    checked={form.mailboxIds.includes(mailbox.id)}
                    onChange={(event) =>
                      update(
                        "mailboxIds",
                        event.target.checked
                          ? [...form.mailboxIds, mailbox.id]
                          : form.mailboxIds.filter((id) => id !== mailbox.id),
                      )
                    }
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  <span className="truncate">{mailbox.address}</span>
                </label>
              ))}
            </div>
            {!mailboxList.length ? (
              <p className="text-[11px] text-amber-600">请先到“邮箱”页面添加邮箱。</p>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
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
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">发件人域名过滤</h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="模式">
                <Select
                  value={form.domainMode}
                  onChange={(event) =>
                    update("domainMode", event.target.value as RuleForm["domainMode"])
                  }
                >
                  <option value="off">不限制</option>
                  <option value="allow">白名单：只允许列表域名</option>
                  <option value="deny">黑名单：排除列表域名</option>
                </Select>
              </Field>
              <label className="flex items-center gap-2 pt-5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={form.includeSubdomains}
                  onChange={(event) => update("includeSubdomains", event.target.checked)}
                  disabled={form.domainMode === "off"}
                  className="h-4 w-4 rounded border-slate-300"
                />
                包含子域名
              </label>
            </div>
            {form.domainMode !== "off" ? (
              <Field
                label="域名列表"
                hint="用逗号或换行分隔，例如 example.com, customer.cn；会自动去掉 @ 和 *. 前缀"
              >
                <Textarea
                  rows={3}
                  value={form.domains}
                  onChange={(event) => update("domains", event.target.value)}
                  placeholder="example.com&#10;customer.cn"
                />
              </Field>
            ) : null}
            <p className="text-[11px] leading-5 text-slate-500">
              域名过滤只影响当前规则。需要全局拉黑时，请使用「设置 → 抑制名单」。
            </p>
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
                  {templateList.map((template) => (
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
              <Field label="延迟发送（秒）" hint="Cloudflare 原生回复不支持延迟；SMTP/API 通道可以延迟">
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
            </div>
            <label className="flex items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={form.replyAsNew}
                onChange={(event) => update("replyAsNew", event.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300"
              />
              <span>
                回复新邮件（不合并会话）
                <span className="mt-0.5 block text-[11px] leading-5 text-slate-400">
                  勾选后不设置 In-Reply-To / References，主题使用模板内容；不勾选则合并到原会话并使用
                  Re: 原主题。
                </span>
              </span>
            </label>
            {form.replyAsNew && selectedHasCfReply ? (
              <p className="text-[11px] leading-5 text-amber-600">
                所选邮箱包含 Cloudflare 原生回复通道。cf_reply 无法发送新会话，命中时会跳过并记录原因，
                请改用 SMTP / Resend / Mailgun。
              </p>
            ) : null}
            {!templateList.length ? (
              <p className="text-[11px] text-amber-600">
                还没有模板，请先到“模板”页面创建。
              </p>
            ) : null}
          </section>
        </div>
      </Modal>
    </div>
  );
}
