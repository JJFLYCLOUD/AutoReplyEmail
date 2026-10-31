import { useEffect, useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks";
import type { AuditEntry, MeResponse, Settings, Suppression } from "../types";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  Select,
  Spinner,
  formatTime,
} from "../ui";

interface SettingsForm {
  enabled: boolean;
  provider: "workers-ai" | "external";
  workersAiModel: string;
  externalBaseUrl: string;
  externalModel: string;
  externalApiKey: string;
  dailyRequestLimit: string;
  classifyFallback: boolean;
  retentionDays: string;
  globalDailyLimit: string;
  timezone: string;
}

const emptyForm: SettingsForm = {
  enabled: false,
  provider: "workers-ai",
  workersAiModel: "@cf/meta/llama-3.1-8b-instruct",
  externalBaseUrl: "https://api.openai.com/v1",
  externalModel: "gpt-4o-mini",
  externalApiKey: "",
  dailyRequestLimit: "200",
  classifyFallback: false,
  retentionDays: "30",
  globalDailyLimit: "500",
  timezone: "UTC",
};

function fromSettings(settings: Settings): SettingsForm {
  return {
    enabled: settings.ai.enabled,
    provider: settings.ai.provider,
    workersAiModel: settings.ai.workersAiModel,
    externalBaseUrl: settings.ai.externalBaseUrl,
    externalModel: settings.ai.externalModel,
    externalApiKey: "",
    dailyRequestLimit: String(settings.ai.dailyRequestLimit),
    classifyFallback: settings.ai.classifyFallback,
    retentionDays: String(settings.retentionDays),
    globalDailyLimit: String(settings.globalDailyLimit),
    timezone: settings.timezone,
  };
}

export default function SettingsPage() {
  const settings = useApi<{ settings: Settings }>("/settings");
  const me = useApi<MeResponse>("/me");
  const suppressions = useApi<{ items: Suppression[] }>("/suppressions");
  const audit = useApi<{ items: AuditEntry[] }>("/audit?limit=50");

  const [form, setForm] = useState<SettingsForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testOutput, setTestOutput] = useState<string | null>(null);
  const [testLoading, setTestLoading] = useState(false);
  const [suppressionAddress, setSuppressionAddress] = useState("");
  const [suppressionReason, setSuppressionReason] = useState("");

  useEffect(() => {
    if (settings.data?.settings) setForm(fromSettings(settings.data.settings));
  }, [settings.data]);

  function update<K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.put("/settings", {
        ai: {
          enabled: form.enabled,
          provider: form.provider,
          workersAiModel: form.workersAiModel,
          externalBaseUrl: form.externalBaseUrl,
          externalModel: form.externalModel,
          dailyRequestLimit: Number(form.dailyRequestLimit) || 0,
          classifyFallback: form.classifyFallback,
          ...(form.externalApiKey ? { externalApiKey: form.externalApiKey } : {}),
        },
        retentionDays: Number(form.retentionDays) || 30,
        globalDailyLimit: Number(form.globalDailyLimit) || 500,
        timezone: form.timezone,
      });
      setNotice("设置已保存");
      setForm((current) => ({ ...current, externalApiKey: "" }));
      settings.reload();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setSaving(false);
    }
  }

  async function clearApiKey() {
    if (!window.confirm("清除外部 AI API Key？")) return;
    try {
      await api.put("/settings", { ai: { externalApiKey: null } });
      setNotice("外部 API Key 已清除");
      settings.reload();
    } catch (err) {
      alert(String(err instanceof Error ? err.message : err));
    }
  }

  async function testAi() {
    setTestLoading(true);
    setTestOutput(null);
    try {
      const result = await api.post<{ ok: boolean; text?: string; error?: string }>(
        "/settings/test-ai",
      );
      setTestOutput(result.ok ? result.text || "" : `失败：${result.error}`);
    } catch (err) {
      setTestOutput(String(err instanceof Error ? err.message : err));
    } finally {
      setTestLoading(false);
    }
  }

  async function addSuppression() {
    if (!suppressionAddress.trim()) return;
    try {
      await api.post("/suppressions", {
        address: suppressionAddress.trim(),
        reason: suppressionReason.trim() || undefined,
      });
      setSuppressionAddress("");
      setSuppressionReason("");
      suppressions.reload();
    } catch (err) {
      alert(String(err instanceof Error ? err.message : err));
    }
  }

  return (
    <div className="space-y-6">
      {notice ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          {notice}
        </div>
      ) : null}
      {error ? <ErrorBox message={error} /> : null}

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">AI 回复</h2>
            <p className="text-[11px] text-slate-400">
              默认使用 Workers AI 免费额度，也可以切换到 OpenAI 兼容接口。
            </p>
          </div>
          <Badge tone={form.enabled ? "green" : "slate"}>{form.enabled ? "已启用" : "已关闭"}</Badge>
        </div>

        {settings.loading && !settings.data ? (
          <div className="mt-4">
            <Spinner />
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="flex items-center gap-2 pt-5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(event) => update("enabled", event.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                启用 AI
              </label>
              <Field label="提供方">
                <Select
                  value={form.provider}
                  onChange={(event) => update("provider", event.target.value as SettingsForm["provider"])}
                >
                  <option value="workers-ai">Workers AI</option>
                  <option value="external">外部 OpenAI 兼容 API</option>
                </Select>
              </Field>
              <Field label="每日请求上限">
                <Input
                  value={form.dailyRequestLimit}
                  onChange={(event) => update("dailyRequestLimit", event.target.value)}
                />
              </Field>
            </div>

            {form.provider === "workers-ai" ? (
              <Field label="Workers AI 模型">
                <Input
                  value={form.workersAiModel}
                  onChange={(event) => update("workersAiModel", event.target.value)}
                  placeholder="@cf/meta/llama-3.1-8b-instruct"
                />
              </Field>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Base URL">
                  <Input
                    value={form.externalBaseUrl}
                    onChange={(event) => update("externalBaseUrl", event.target.value)}
                    placeholder="https://api.openai.com/v1"
                  />
                </Field>
                <Field label="模型">
                  <Input
                    value={form.externalModel}
                    onChange={(event) => update("externalModel", event.target.value)}
                    placeholder="gpt-4o-mini"
                  />
                </Field>
                <Field
                  label="API Key"
                  hint={
                    settings.data?.settings.ai.hasExternalApiKey
                      ? "已保存 Key；留空保持不变"
                      : "尚未配置 Key"
                  }
                >
                  <Input
                    type="password"
                    value={form.externalApiKey}
                    onChange={(event) => update("externalApiKey", event.target.value)}
                    placeholder="sk-..."
                  />
                </Field>
                <div className="flex items-end">
                  <Button variant="outline" size="sm" onClick={() => void clearApiKey()}>
                    清除已保存的 Key
                  </Button>
                </div>
              </div>
            )}

            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={form.classifyFallback}
                onChange={(event) => update("classifyFallback", event.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              关键词没有命中时，用 AI 在所有模板中选择（置信度 ≥ 0.6 才回复）
            </label>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void save()} disabled={saving}>
                {saving ? "保存中…" : "保存 AI 设置"}
              </Button>
              <Button variant="outline" onClick={() => void testAi()} disabled={testLoading || !form.enabled}>
                {testLoading ? "测试中…" : "测试 AI"}
              </Button>
            </div>

            {testOutput ? (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-[11px] leading-5 text-slate-600 scrollbar-thin">
                {testOutput}
              </pre>
            ) : null}
          </div>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold text-slate-800">通用与数据保留</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="原文保留天数">
            <Input
              value={form.retentionDays}
              onChange={(event) => update("retentionDays", event.target.value)}
            />
          </Field>
          <Field label="每个邮箱每日发信上限">
            <Input
              value={form.globalDailyLimit}
              onChange={(event) => update("globalDailyLimit", event.target.value)}
            />
          </Field>
          <Field label="默认时区">
            <Input value={form.timezone} onChange={(event) => update("timezone", event.target.value)} />
          </Field>
        </div>
        <div className="mt-3">
          <Button onClick={() => void save()} disabled={saving}>
            保存通用设置
          </Button>
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold text-slate-800">抑制名单</h2>
        <p className="text-[11px] text-slate-400">
          支持完整地址、域名（example.com）或 @example.com。命中后不会自动回复。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Input
            className="w-64"
            value={suppressionAddress}
            onChange={(event) => setSuppressionAddress(event.target.value)}
            placeholder="spam@example.com / example.com"
          />
          <Input
            className="w-64"
            value={suppressionReason}
            onChange={(event) => setSuppressionReason(event.target.value)}
            placeholder="原因（可选）"
          />
          <Button onClick={() => void addSuppression()}>添加</Button>
        </div>
        <div className="mt-3 overflow-x-auto">
          {(suppressions.data?.items.length || 0) === 0 ? (
            <div className="py-3 text-xs text-slate-400">暂无抑制项</div>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">地址</th>
                  <th className="px-3 py-2 font-medium">原因</th>
                  <th className="px-3 py-2 font-medium">创建时间</th>
                  <th className="px-3 py-2 font-medium">过期时间</th>
                  <th className="px-3 py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(suppressions.data?.items || []).map((item) => (
                  <tr key={item.id}>
                    <td className="px-3 py-2 text-slate-700">{item.address}</td>
                    <td className="px-3 py-2 text-slate-500">{item.reason || "-"}</td>
                    <td className="px-3 py-2 text-slate-500">{formatTime(item.created_at)}</td>
                    <td className="px-3 py-2 text-slate-500">{item.expires_at ? formatTime(item.expires_at) : "永久"}</td>
                    <td className="px-3 py-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          void api.del(`/suppressions/${item.id}`).then(() => suppressions.reload());
                        }}
                      >
                        删除
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="text-sm font-semibold text-slate-800">安全与登录</h2>
          <div className="mt-3 space-y-2 text-xs text-slate-600">
            <div className="flex items-center justify-between">
              <span>登录方式</span>
              <Badge tone="green">账号密码</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span>登录账号</span>
              <span className="font-mono text-slate-500">
                {me.data?.auth.username || "-"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>会话有效期</span>
              <span className="text-slate-500">
                {me.data?.auth.sessionHours ?? 12} 小时
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>凭据加密</span>
              <Badge tone="green">AES-256-GCM</Badge>
            </div>
          </div>
          <p className="mt-3 text-[11px] leading-5 text-slate-400">
            账号密码由 Worker 变量 <code>AUTH_USERNAME</code> / <code>AUTH_PASSWORD</code> 控制；
            修改 <code>AUTH_PASSWORD</code> 会使已有会话失效。
          </p>
        </Card>

        <Card className="p-4">
          <h2 className="text-sm font-semibold text-slate-800">运行方式</h2>
          <div className="mt-3 space-y-2 text-xs text-slate-600">
            <div className="flex items-center justify-between">
              <span>免费版队列</span>
              <span className="text-slate-500">D1 outbox + Cron</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Cron</span>
              <span className="text-slate-500">每分钟</span>
            </div>
            <div className="flex items-center justify-between">
              <span>IMAP 轮询</span>
              <span className="text-slate-500">每 1–5 分钟</span>
            </div>
            <div className="flex items-center justify-between">
              <span>CF 邮箱回复</span>
              <span className="text-slate-500">message.reply()</span>
            </div>
          </div>
          <p className="mt-3 text-[11px] leading-5 text-slate-400">
            Cloudflare 邮箱只能即时回复；如果需要延迟，请配置 SMTP 或 API 通道。
          </p>
        </Card>
      </div>

      <Card className="p-4">
        <h2 className="text-sm font-semibold text-slate-800">审计日志</h2>
        {(audit.data?.items.length || 0) === 0 ? (
          <EmptyState title="暂无审计记录" />
        ) : (
          <div className="mt-3 max-h-72 overflow-auto scrollbar-thin">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">时间</th>
                  <th className="px-3 py-2 font-medium">操作人</th>
                  <th className="px-3 py-2 font-medium">动作</th>
                  <th className="px-3 py-2 font-medium">对象</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(audit.data?.items || []).map((entry) => (
                  <tr key={entry.id}>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-500">
                      {formatTime(entry.created_at)}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{entry.actor || "-"}</td>
                    <td className="px-3 py-2 text-slate-700">{entry.action}</td>
                    <td className="px-3 py-2 text-slate-500">
                      {entry.target_type}:{entry.target_id}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
