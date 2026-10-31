import { useMemo, useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks";
import type { Job, Mailbox, Message } from "../types";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Input,
  Modal,
  Select,
  Spinner,
  formatTime,
} from "../ui";
import { directionLabel, statusLabel, statusTone } from "../status";

export default function LogsPage() {
  const mailboxes = useApi<{ items: Mailbox[] }>("/mailboxes");
  const [mailboxId, setMailboxId] = useState("");
  const [direction, setDirection] = useState("");
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");

  const params = new URLSearchParams();
  if (mailboxId) params.set("mailboxId", mailboxId);
  if (direction) params.set("direction", direction);
  if (status) params.set("status", status);
  if (appliedQuery) params.set("q", appliedQuery);
  params.set("limit", "100");

  const messages = useApi<{ items: Message[] }>(`/messages?${params.toString()}`);
  const jobs = useApi<{ items: Job[] }>("/jobs?limit=50");

  const [selected, setSelected] = useState<{ message: Message; raw: string | null } | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const mailboxMap = useMemo(
    () => new Map((mailboxes.data?.items || []).map((item) => [item.id, item])),
    [mailboxes.data],
  );

  async function openMessage(message: Message) {
    setLoadingDetail(true);
    try {
      const detail = await api.get<{ message: Message; raw: string | null }>(`/messages/${message.id}`);
      setSelected(detail);
    } catch (err) {
      alert(String(err instanceof Error ? err.message : err));
    } finally {
      setLoadingDetail(false);
    }
  }

  async function resend(message: Message) {
    if (!window.confirm("重新发送这封自动回复？")) return;
    try {
      await api.post(`/messages/${message.id}/resend`);
      setNotice("已重新发送");
    } catch (err) {
      alert(String(err instanceof Error ? err.message : err));
    }
  }

  async function remove(message: Message) {
    if (!window.confirm("删除这条日志及其原文？")) return;
    try {
      await api.del(`/messages/${message.id}`);
      setSelected(null);
      messages.reload();
    } catch (err) {
      alert(String(err instanceof Error ? err.message : err));
    }
  }

  async function drain() {
    try {
      const result = await api.post<{ processed: number }>("/jobs/drain");
      setNotice(`已执行 ${result.processed} 个任务`);
      jobs.reload();
    } catch (err) {
      alert(String(err instanceof Error ? err.message : err));
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-48" value={mailboxId} onChange={(event) => setMailboxId(event.target.value)}>
          <option value="">全部邮箱</option>
          {(mailboxes.data?.items || []).map((mailbox) => (
            <option key={mailbox.id} value={mailbox.id}>
              {mailbox.address}
            </option>
          ))}
        </Select>
        <Select className="w-32" value={direction} onChange={(event) => setDirection(event.target.value)}>
          <option value="">全部方向</option>
          <option value="in">收件</option>
          <option value="out">发件</option>
        </Select>
        <Select className="w-36" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">全部状态</option>
          <option value="replied">已回复</option>
          <option value="sent">已发送</option>
          <option value="queued">排队中</option>
          <option value="skipped">已跳过</option>
          <option value="failed">失败</option>
          <option value="received">已接收</option>
        </Select>
        <div className="flex min-w-[240px] flex-1 gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") setAppliedQuery(query.trim());
            }}
            placeholder="搜索主题、发件人、收件人"
          />
          <Button variant="outline" onClick={() => setAppliedQuery(query.trim())}>
            搜索
          </Button>
        </div>
        <Button variant="outline" onClick={messages.reload}>
          刷新
        </Button>
      </div>

      {notice ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          {notice}
        </div>
      ) : null}
      {messages.error ? <ErrorBox message={messages.error} /> : null}
      {messages.loading && !messages.data ? <Spinner /> : null}

      <Card>
        {(messages.data?.items.length || 0) === 0 && !messages.loading ? (
          <EmptyState title="没有匹配的邮件" description="调整筛选条件，或等待新的入站邮件。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">时间</th>
                  <th className="px-4 py-2 font-medium">邮箱</th>
                  <th className="px-4 py-2 font-medium">方向</th>
                  <th className="px-4 py-2 font-medium">发件人 / 收件人</th>
                  <th className="px-4 py-2 font-medium">主题</th>
                  <th className="px-4 py-2 font-medium">状态</th>
                  <th className="px-4 py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(messages.data?.items || []).map((message) => {
                  const to = (() => {
                    try {
                      return (JSON.parse(message.to_json || "[]") as string[]).join(", ");
                    } catch {
                      return "";
                    }
                  })();
                  return (
                    <tr key={message.id} className="hover:bg-slate-50">
                      <td className="whitespace-nowrap px-4 py-2 text-slate-500">
                        {formatTime(message.received_at)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-slate-500">
                        {mailboxMap.get(message.mailbox_id)?.address || "-"}
                      </td>
                      <td className="px-4 py-2">
                        <Badge tone={message.direction === "in" ? "blue" : "indigo"}>
                          {directionLabel(message.direction)}
                        </Badge>
                      </td>
                      <td className="max-w-[220px] truncate px-4 py-2 text-slate-600">
                        {message.direction === "in" ? message.from_addr : to}
                      </td>
                      <td className="max-w-[260px] truncate px-4 py-2 text-slate-700">
                        {message.subject || "(无主题)"}
                      </td>
                      <td className="px-4 py-2">
                        <Badge tone={statusTone(message.status)}>{statusLabel(message.status)}</Badge>
                      </td>
                      <td className="px-4 py-2">
                        <Button variant="ghost" size="sm" onClick={() => void openMessage(message)}>
                          查看
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">任务队列</h2>
            <p className="text-[11px] text-slate-400">免费版无 Queue，使用 D1 outbox + Cron 消费</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={jobs.reload}>
              刷新
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void drain()}>
              立即执行
            </Button>
          </div>
        </div>
        {(jobs.data?.items.length || 0) === 0 ? (
          <div className="px-4 py-6 text-xs text-slate-400">暂无任务</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">创建时间</th>
                  <th className="px-4 py-2 font-medium">类型</th>
                  <th className="px-4 py-2 font-medium">状态</th>
                  <th className="px-4 py-2 font-medium">尝试</th>
                  <th className="px-4 py-2 font-medium">计划执行</th>
                  <th className="px-4 py-2 font-medium">错误</th>
                  <th className="px-4 py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(jobs.data?.items || []).map((job) => (
                  <tr key={job.id} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-2 text-slate-500">
                      {formatTime(job.created_at)}
                    </td>
                    <td className="px-4 py-2 text-slate-700">{job.kind}</td>
                    <td className="px-4 py-2">
                      <Badge tone={statusTone(job.status)}>{statusLabel(job.status)}</Badge>
                    </td>
                    <td className="px-4 py-2 text-slate-500">
                      {job.attempts}/{job.max_attempts}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-slate-500">
                      {formatTime(job.run_at)}
                    </td>
                    <td className="max-w-[260px] truncate px-4 py-2 text-rose-500">
                      {job.last_error || "-"}
                    </td>
                    <td className="px-4 py-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          void api.post(`/jobs/${job.id}/retry`).then(() => jobs.reload());
                        }}
                      >
                        重试
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={Boolean(selected)}
        title={selected ? selected.message.subject || "(无主题)" : "邮件详情"}
        onClose={() => setSelected(null)}
        width="max-w-4xl"
        footer={
          selected ? (
            <>
              <Button variant="outline" onClick={() => setSelected(null)}>
                关闭
              </Button>
              {selected.message.direction === "out" ? (
                <Button variant="secondary" onClick={() => void resend(selected.message)}>
                  重新发送
                </Button>
              ) : null}
              <Button variant="danger" onClick={() => void remove(selected.message)}>
                删除
              </Button>
            </>
          ) : null
        }
      >
        {loadingDetail ? <Spinner /> : null}
        {selected ? (
          <div className="space-y-3">
            <div className="grid gap-2 rounded-lg bg-slate-50 p-3 text-xs sm:grid-cols-2">
              <div>
                <span className="text-slate-400">邮箱：</span>
                {mailboxMap.get(selected.message.mailbox_id)?.address || selected.message.mailbox_id}
              </div>
              <div>
                <span className="text-slate-400">状态：</span>
                <Badge tone={statusTone(selected.message.status)}>
                  {statusLabel(selected.message.status)}
                </Badge>
              </div>
              <div>
                <span className="text-slate-400">方向：</span>
                {directionLabel(selected.message.direction)}
              </div>
              <div>
                <span className="text-slate-400">时间：</span>
                {formatTime(selected.message.received_at)}
              </div>
              <div className="truncate">
                <span className="text-slate-400">From：</span>
                {selected.message.from_addr || "-"}
              </div>
              <div className="truncate">
                <span className="text-slate-400">To：</span>
                {selected.message.to_json || "-"}
              </div>
              <div className="truncate">
                <span className="text-slate-400">Message-ID：</span>
                {selected.message.message_id || "-"}
              </div>
              <div className="truncate">
                <span className="text-slate-400">规则：</span>
                {selected.message.rule_id || "-"}
              </div>
              {selected.message.error ? (
                <div className="col-span-2 text-rose-600">
                  <span className="text-slate-400">错误：</span>
                  {selected.message.error}
                </div>
              ) : null}
            </div>

            <div>
              <h4 className="mb-1 text-xs font-medium text-slate-600">正文</h4>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-[11px] leading-5 text-slate-700 scrollbar-thin">
                {selected.message.body_text || selected.message.snippet || "(无正文)"}
              </pre>
            </div>

            {selected.raw ? (
              <div>
                <h4 className="mb-1 text-xs font-medium text-slate-600">原始邮件（截断）</h4>
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-900 p-3 text-[11px] leading-5 text-slate-200 scrollbar-thin">
                  {selected.raw}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
