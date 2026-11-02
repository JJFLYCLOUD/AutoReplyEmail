import { useMemo, useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks";
import type { Mailbox } from "../types";
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
  formatTime,
} from "../ui";
import { channelLabel } from "../status";

interface MailboxForm {
  address: string;
  displayName: string;
  matchMode: "exact" | "domain";
  timezone: string;
  enabled: boolean;
  inboundKind: "cf_routing" | "imap" | "pop3";
  host: string;
  port: string;
  tls: boolean;
  username: string;
  password: string;
  folder: string;
  pollIntervalSec: string;
  initialSync: "skip" | "recent";
  fetchLimit: string;
  outboundKind: "cf_reply" | "smtp" | "resend" | "mailgun";
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  apiKey: string;
  mailgunDomain: string;
  fromName: string;
  replyTo: string;
  dailyLimit: string;
}

const emptyForm: MailboxForm = {
  address: "",
  displayName: "",
  matchMode: "exact",
  timezone: "Asia/Shanghai",
  enabled: true,
  inboundKind: "cf_routing",
  host: "imap.gmail.com",
  port: "993",
  tls: true,
  username: "",
  password: "",
  folder: "INBOX",
  pollIntervalSec: "300",
  initialSync: "skip",
  fetchLimit: "2",
  outboundKind: "cf_reply",
  smtpHost: "smtp.gmail.com",
  smtpPort: "465",
  smtpSecure: true,
  smtpUser: "",
  smtpPassword: "",
  apiKey: "",
  mailgunDomain: "",
  fromName: "",
  replyTo: "",
  dailyLimit: "100",
};

function formFromMailbox(mailbox: Mailbox): MailboxForm {
  const inbound = mailbox.inbound[0];
  const outbound = mailbox.outbound[0];
  const inboundConfig = (inbound?.config || {}) as Record<string, unknown>;
  const outboundConfig = (outbound?.config || {}) as Record<string, unknown>;
  return {
    ...emptyForm,
    address: mailbox.address,
    displayName: mailbox.display_name || "",
    matchMode: mailbox.match_mode === "domain" ? "domain" : "exact",
    timezone: mailbox.timezone || "Asia/Shanghai",
    enabled: mailbox.enabled,
    inboundKind: (inbound?.kind as MailboxForm["inboundKind"]) || "cf_routing",
    host: String(inboundConfig.host || ""),
    port: String(inboundConfig.port || 993),
    tls: inboundConfig.tls !== false,
    username: String(inboundConfig.username || ""),
    password: "",
    folder: String(inboundConfig.folder || "INBOX"),
    pollIntervalSec: String(inboundConfig.pollIntervalSec || 300),
    initialSync: inboundConfig.initialSync === "recent" ? "recent" : "skip",
    fetchLimit: String(inboundConfig.fetchLimit || 2),
    outboundKind: (outbound?.kind as MailboxForm["outboundKind"]) || "cf_reply",
    smtpHost: String(outboundConfig.host || ""),
    smtpPort: String(outboundConfig.port || 465),
    smtpSecure: outboundConfig.secure !== false,
    smtpUser: String(outboundConfig.username || ""),
    smtpPassword: "",
    apiKey: "",
    mailgunDomain: String(outboundConfig.domain || ""),
    fromName: outbound?.fromName || "",
    replyTo: outbound?.replyTo || "",
    dailyLimit: String(outbound?.dailyLimit || 100),
  };
}

export default function MailboxesPage() {
  const { data, loading, error, reload } = useApi<{ items: Mailbox[] }>("/mailboxes");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Mailbox | null>(null);
  const [form, setForm] = useState<MailboxForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mailboxes = useMemo(() => data?.items || [], [data]);

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setFormError(null);
    setOpen(true);
  }

  function openEdit(mailbox: Mailbox) {
    setEditing(mailbox);
    setForm(formFromMailbox(mailbox));
    setFormError(null);
    setOpen(true);
  }

  function update<K extends keyof MailboxForm>(key: K, value: MailboxForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        address: form.address.trim(),
        displayName: form.displayName.trim() || undefined,
        matchMode: form.matchMode,
        timezone: form.timezone,
        enabled: form.enabled,
        inbound: {
          kind: form.inboundKind,
          host: form.host || undefined,
          port: Number(form.port) || undefined,
          tls: form.tls,
          username: form.username || undefined,
          password: form.password || undefined,
          folder: form.folder || undefined,
          pollIntervalSec: Number(form.pollIntervalSec) || undefined,
          initialSync: form.initialSync,
          fetchLimit: Number(form.fetchLimit) || undefined,
        },
        outbound: {
          kind: form.outboundKind,
          host: form.smtpHost || undefined,
          port: Number(form.smtpPort) || undefined,
          secure: form.smtpSecure,
          username: form.smtpUser || undefined,
          password: form.smtpPassword || undefined,
          apiKey: form.apiKey || undefined,
          domain: form.mailgunDomain || undefined,
          fromName: form.fromName || undefined,
          replyTo: form.replyTo || undefined,
          dailyLimit: Number(form.dailyLimit) || undefined,
        },
      };
      if (editing) await api.patch(`/mailboxes/${editing.id}`, payload);
      else await api.post("/mailboxes", payload);
      setOpen(false);
      setNotice(editing ? "邮箱已更新" : "邮箱已创建");
      reload();
    } catch (err) {
      setFormError(String(err instanceof Error ? err.message : err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(mailbox: Mailbox) {
    if (!window.confirm(`删除邮箱 ${mailbox.address}？相关规则、模板与日志会一并删除。`)) return;
    try {
      await api.del(`/mailboxes/${mailbox.id}`);
      setNotice("邮箱已删除");
      reload();
    } catch (err) {
      alert(String(err instanceof Error ? err.message : err));
    }
  }

  async function testInbound(mailbox: Mailbox) {
    try {
      const result = await api.post<{
        ok: boolean;
        kind?: string;
        folder?: string;
        exists?: number;
        count?: number;
        unique?: number;
        error?: string;
      }>(`/mailboxes/${mailbox.id}/test-inbound`);
      if (!result.ok) {
        setNotice(`收信失败：${result.error}`);
        return;
      }
      setNotice(
        result.kind === "pop3"
          ? `POP3 连接成功：${result.count || 0} 封邮件，${result.unique || 0} 个 UID`
          : `IMAP 连接成功：${result.folder || "INBOX"}，${result.exists || 0} 封邮件`,
      );
    } catch (err) {
      alert(String(err instanceof Error ? err.message : err));
    }
  }

  async function testOutbound(mailbox: Mailbox) {
    const to = window.prompt("发送测试邮件到：", mailbox.address);
    if (!to) return;
    try {
      const result = await api.post<{ ok: boolean; error?: string }>(
        `/mailboxes/${mailbox.id}/test-outbound`,
        { to },
      );
      setNotice(result.ok ? "测试邮件已发送" : `测试发送失败：${result.error}`);
    } catch (err) {
      alert(String(err instanceof Error ? err.message : err));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          一个邮箱可使用 Cloudflare 入站或 IMAP 拉取；发信支持 CF 原生回复、SMTP、Resend、Mailgun。
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={reload}>
            刷新
          </Button>
          <Button size="sm" onClick={openCreate}>
            添加邮箱
          </Button>
        </div>
      </div>

      {notice ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          {notice}
        </div>
      ) : null}
      {error ? <ErrorBox message={error} /> : null}
      {loading && !data ? <Spinner /> : null}

      {!loading && mailboxes.length === 0 ? (
        <EmptyState
          title="还没有邮箱"
          description="先添加一个 Cloudflare 域名邮箱或 Gmail 邮箱。"
          action={<Button onClick={openCreate}>添加第一个邮箱</Button>}
        />
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        {mailboxes.map((mailbox) => (
          <Card key={mailbox.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-sm font-semibold text-slate-800">{mailbox.address}</h2>
                  <Badge tone={mailbox.enabled ? "green" : "slate"}>
                    {mailbox.enabled ? "启用" : "停用"}
                  </Badge>
                  {mailbox.match_mode === "domain" ? <Badge tone="amber">整域匹配</Badge> : null}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {mailbox.display_name || "未设置显示名"} · {mailbox.timezone}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="outline" size="sm" onClick={() => openEdit(mailbox)}>
                  编辑
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void remove(mailbox)}>
                  删除
                </Button>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
              <div className="rounded-lg bg-slate-50 px-2.5 py-2">
                <div className="text-slate-400">入站</div>
                <div className="mt-0.5 font-medium text-slate-700">
                  {mailbox.inbound.length
                    ? mailbox.inbound.map((channel) => channelLabel(channel.kind)).join(" / ")
                    : "未配置"}
                </div>
                {mailbox.inbound[0]?.lastError ? (
                  <div className="mt-1 line-clamp-2 text-rose-500">{mailbox.inbound[0].lastError}</div>
                ) : null}
                {mailbox.inbound[0]?.lastCheckedAt ? (
                  <div className="mt-1 text-slate-400">
                    上次检查 {formatTime(mailbox.inbound[0].lastCheckedAt)}
                  </div>
                ) : null}
              </div>
              <div className="rounded-lg bg-slate-50 px-2.5 py-2">
                <div className="text-slate-400">发信</div>
                <div className="mt-0.5 font-medium text-slate-700">
                  {mailbox.outbound.length
                    ? mailbox.outbound
                        .map(
                          (channel) =>
                            `${channelLabel(channel.kind)}${
                              channel.kind !== "cf_reply" && !channel.hasSecret ? "（无凭据）" : ""
                            }`,
                        )
                        .join(" / ")
                    : "未配置"}
                </div>
                <div className="mt-1 text-slate-400">
                  规则 {mailbox.ruleCount}
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {mailbox.inbound.some(
                (channel) => channel.kind === "imap" || channel.kind === "pop3",
              ) ? (
                <Button variant="outline" size="sm" onClick={() => void testInbound(mailbox)}>
                  测试收信
                </Button>
              ) : null}
              {mailbox.outbound.some((channel) => channel.kind !== "cf_reply") ? (
                <Button variant="outline" size="sm" onClick={() => void testOutbound(mailbox)}>
                  测试发信
                </Button>
              ) : null}
            </div>
          </Card>
        ))}
      </div>

      <Modal
        open={open}
        title={editing ? `编辑 ${editing.address}` : "添加邮箱"}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void save()} disabled={saving || !form.address.trim()}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {formError ? <ErrorBox message={formError} /> : null}

          <section className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">基本信息</h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="邮箱地址">
                <Input
                  value={form.address}
                  onChange={(event) => update("address", event.target.value)}
                  placeholder="support@example.com"
                />
              </Field>
              <Field label="显示名称">
                <Input
                  value={form.displayName}
                  onChange={(event) => update("displayName", event.target.value)}
                  placeholder="Support Team"
                />
              </Field>
              <Field label="匹配模式" hint="整域匹配会把该域名下未单独配置的地址都交给这个邮箱处理">
                <Select
                  value={form.matchMode}
                  onChange={(event) => update("matchMode", event.target.value as MailboxForm["matchMode"])}
                >
                  <option value="exact">精确地址</option>
                  <option value="domain">整个域名</option>
                </Select>
              </Field>
              <Field label="时区">
                <Input
                  value={form.timezone}
                  onChange={(event) => update("timezone", event.target.value)}
                  placeholder="Asia/Shanghai"
                />
              </Field>
              <label className="flex items-center gap-2 pt-5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(event) => update("enabled", event.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                启用此邮箱
              </label>
            </div>
          </section>

          <section className="space-y-3 rounded-lg border border-slate-200 p-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">入站</h4>
            <Field label="入站方式">
              <Select
                value={form.inboundKind}
                onChange={(event) => update("inboundKind", event.target.value as MailboxForm["inboundKind"])}
              >
                <option value="cf_routing">Cloudflare Email Routing（免费、即时）</option>
                <option value="imap">IMAP（Gmail / 自定义邮箱）</option>
                <option value="pop3">POP3（传统邮箱）</option>
              </Select>
            </Field>
            {form.inboundKind === "cf_routing" ? (
              <p className="text-[11px] leading-5 text-slate-500">
                在 Cloudflare Dashboard → Email Routing 中将该地址或 catch-all 路由到本 Worker 即可。
                自动回复将使用 Cloudflare 原生 reply()，无需 SMTP 凭据。
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="IMAP 主机">
                  <Input value={form.host} onChange={(event) => update("host", event.target.value)} />
                </Field>
                <Field label="端口">
                  <Input value={form.port} onChange={(event) => update("port", event.target.value)} />
                </Field>
                <Field label="用户名">
                  <Input
                    value={form.username}
                    onChange={(event) => update("username", event.target.value)}
                    placeholder="you@gmail.com"
                  />
                </Field>
                <Field label="密码 / 应用专用密码" hint={editing ? "留空表示保持原密码" : undefined}>
                  <Input
                    type="password"
                    value={form.password}
                    onChange={(event) => update("password", event.target.value)}
                  />
                </Field>
                <Field label="文件夹">
                  <Input value={form.folder} onChange={(event) => update("folder", event.target.value)} />
                </Field>
                <Field label="轮询间隔（秒）">
                  <Input
                    value={form.pollIntervalSec}
                    onChange={(event) => update("pollIntervalSec", event.target.value)}
                  />
                </Field>
                <Field label="首次同步">
                  <Select
                    value={form.initialSync}
                    onChange={(event) => update("initialSync", event.target.value as "skip" | "recent")}
                  >
                    <option value="skip">跳过历史邮件（推荐）</option>
                    <option value="recent">处理最近 5 封</option>
                  </Select>
                </Field>
                <Field label="每次拉取数量">
                  <Input
                    value={form.fetchLimit}
                    onChange={(event) => update("fetchLimit", event.target.value)}
                  />
                </Field>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={form.tls}
                    onChange={(event) => update("tls", event.target.checked)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  使用隐式 TLS（993/995）
                </label>
              </div>
            )}
          </section>

          <section className="space-y-3 rounded-lg border border-slate-200 p-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">发信</h4>
            <Field label="发信方式">
              <Select
                value={form.outboundKind}
                onChange={(event) => update("outboundKind", event.target.value as MailboxForm["outboundKind"])}
              >
                <option value="cf_reply">Cloudflare 原生回复（仅 CF 入站）</option>
                <option value="smtp">SMTP</option>
                <option value="resend">Resend API</option>
                <option value="mailgun">Mailgun API</option>
              </Select>
            </Field>
            <p className="text-[11px] text-slate-500">
              该邮箱只使用这一种发信方式，失败不会自动切换。
            </p>

            {form.outboundKind === "cf_reply" ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-700">
                Cloudflare 原生回复仅执行首个匹配规则，只回复一封邮件，也无法发送新会话。需要多规则回复或新会话，请改用
                SMTP / Resend / Mailgun。
              </div>
            ) : null}
            {form.outboundKind === "cf_reply" ? (
              <p className="text-[11px] leading-5 text-slate-500">
                仅适用于 Cloudflare Email Routing 入站邮件；只能即时回复，失败不会切换其他通道。
              </p>
            ) : null}

            {form.outboundKind === "smtp" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="SMTP 主机">
                  <Input
                    value={form.smtpHost}
                    onChange={(event) => update("smtpHost", event.target.value)}
                    placeholder="smtp.gmail.com"
                  />
                </Field>
                <Field label="端口">
                  <Input
                    value={form.smtpPort}
                    onChange={(event) => update("smtpPort", event.target.value)}
                  />
                </Field>
                <Field label="用户名">
                  <Input
                    value={form.smtpUser}
                    onChange={(event) => update("smtpUser", event.target.value)}
                  />
                </Field>
                <Field label="密码 / 授权码" hint={editing ? "留空表示保持原密码" : undefined}>
                  <Input
                    type="password"
                    value={form.smtpPassword}
                    onChange={(event) => update("smtpPassword", event.target.value)}
                  />
                </Field>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={form.smtpSecure}
                    onChange={(event) => update("smtpSecure", event.target.checked)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  隐式 TLS（465）
                </label>
              </div>
            ) : null}

            {form.outboundKind === "resend" ? (
              <Field label="Resend API Key" hint={editing ? "留空表示保持原 Key" : undefined}>
                <Input
                  type="password"
                  value={form.apiKey}
                  onChange={(event) => update("apiKey", event.target.value)}
                  placeholder="re_..."
                />
              </Field>
            ) : null}

            {form.outboundKind === "mailgun" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Mailgun 域名">
                  <Input
                    value={form.mailgunDomain}
                    onChange={(event) => update("mailgunDomain", event.target.value)}
                    placeholder="mg.example.com"
                  />
                </Field>
                <Field label="Mailgun API Key">
                  <Input
                    type="password"
                    value={form.apiKey}
                    onChange={(event) => update("apiKey", event.target.value)}
                  />
                </Field>
              </div>
            ) : null}

            {form.outboundKind !== "cf_reply" ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="发件人名称">
                  <Input
                    value={form.fromName}
                    onChange={(event) => update("fromName", event.target.value)}
                  />
                </Field>
                <Field label="Reply-To">
                  <Input
                    value={form.replyTo}
                    onChange={(event) => update("replyTo", event.target.value)}
                  />
                </Field>
                <Field label="每日上限">
                  <Input
                    value={form.dailyLimit}
                    onChange={(event) => update("dailyLimit", event.target.value)}
                  />
                </Field>
              </div>
            ) : null}
          </section>
        </div>
      </Modal>
    </div>
  );
}
