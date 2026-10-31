import { useApi } from "../hooks";
import type { StatsResponse } from "../types";
import { Badge, Button, Card, EmptyState, ErrorBox, Spinner, formatTime } from "../ui";
import { directionLabel, statusLabel, statusTone } from "../status";

export default function DashboardPage({
  onNavigate,
}: {
  onNavigate: (page: "dashboard" | "mailboxes" | "rules" | "templates" | "logs" | "settings") => void;
}) {
  const { data, loading, error, reload } = useApi<StatsResponse>("/stats");

  if (loading && !data) return <Spinner label="加载概览…" />;
  if (error) return <ErrorBox message={error} />;
  if (!data) return null;

  const cards = [
    { label: "今日收件", value: data.today.inbound, tone: "text-sky-600" },
    { label: "今日已回复", value: data.today.replied, tone: "text-emerald-600" },
    { label: "今日跳过", value: data.today.skipped, tone: "text-slate-500" },
    { label: "今日失败", value: data.today.failed, tone: "text-rose-600" },
    { label: "待处理任务", value: data.pendingJobs, tone: "text-amber-600" },
    { label: "AI 请求", value: data.aiRequests, tone: "text-indigo-600" },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {cards.map((card) => (
          <Card key={card.label} className="px-4 py-3">
            <div className="text-[11px] text-slate-500">{card.label}</div>
            <div className={"mt-1 text-2xl font-semibold " + card.tone}>{card.value}</div>
          </Card>
        ))}
      </div>

      {data.mailboxes === 0 ? (
        <Card className="p-6">
          <h2 className="text-sm font-semibold text-slate-800">开始配置</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            添加第一个邮箱，然后创建回复模板和关键词规则。Cloudflare Email Routing
            邮箱可以直接使用免费的原生回复；Gmail 等外部邮箱通过 IMAP + SMTP 工作。
          </p>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => onNavigate("mailboxes")}>添加邮箱</Button>
            <Button variant="outline" onClick={() => onNavigate("templates")}>
              创建模板
            </Button>
          </div>
        </Card>
      ) : null}

      <Card>
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800">最近邮件</h2>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={reload}>
              刷新
            </Button>
            <Button variant="outline" size="sm" onClick={() => onNavigate("logs")}>
              查看全部
            </Button>
          </div>
        </div>
        {data.recent.length === 0 ? (
          <EmptyState title="还没有邮件记录" description="收到邮件或发出自动回复后会显示在这里。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">时间</th>
                  <th className="px-4 py-2 font-medium">方向</th>
                  <th className="px-4 py-2 font-medium">发件人</th>
                  <th className="px-4 py-2 font-medium">主题</th>
                  <th className="px-4 py-2 font-medium">状态</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.recent.map((message) => (
                  <tr key={message.id} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-2 text-slate-500">
                      {formatTime(message.received_at)}
                    </td>
                    <td className="px-4 py-2">
                      <Badge tone={message.direction === "in" ? "blue" : "indigo"}>
                        {directionLabel(message.direction)}
                      </Badge>
                    </td>
                    <td className="max-w-[220px] truncate px-4 py-2 text-slate-600">
                      {message.from_name || message.from_addr || "-"}
                    </td>
                    <td className="max-w-[320px] truncate px-4 py-2 text-slate-700">
                      {message.subject || "(无主题)"}
                    </td>
                    <td className="px-4 py-2">
                      <Badge tone={statusTone(message.status)}>{statusLabel(message.status)}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-3 md:grid-cols-3">
        <QuickCard
          title="邮箱"
          value={`${data.mailboxes} 个`}
          description="Cloudflare Routing / IMAP"
          onClick={() => onNavigate("mailboxes")}
        />
        <QuickCard
          title="规则"
          value="关键词 + AI"
          description="冷却、线程上限、业务时间"
          onClick={() => onNavigate("rules")}
        />
        <QuickCard
          title="模板"
          value="多语言"
          description="变量、HTML、预览与测试"
          onClick={() => onNavigate("templates")}
        />
      </div>
    </div>
  );
}

function QuickCard({
  title,
  value,
  description,
  onClick,
}: {
  title: string;
  value: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-indigo-200 hover:bg-indigo-50/30"
    >
      <div className="text-[11px] text-slate-500">{title}</div>
      <div className="mt-1 text-sm font-semibold text-slate-800">{value}</div>
      <div className="mt-1 text-[11px] text-slate-400">{description}</div>
    </button>
  );
}
