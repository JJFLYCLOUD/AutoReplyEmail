import { useCallback, useEffect, useState } from "react";
import { ApiError, api, getDevUser, setDevUser } from "./api";
import type { MeResponse } from "./types";
import { Badge, Button, Input, Spinner } from "./ui";
import DashboardPage from "./pages/Dashboard";
import MailboxesPage from "./pages/Mailboxes";
import RulesPage from "./pages/Rules";
import TemplatesPage from "./pages/Templates";
import LogsPage from "./pages/Logs";
import SettingsPage from "./pages/Settings";

type Page = "dashboard" | "mailboxes" | "rules" | "templates" | "logs" | "settings";

const NAV: Array<{ id: Page; label: string; hint: string }> = [
  { id: "dashboard", label: "概览", hint: "运行状态" },
  { id: "mailboxes", label: "邮箱", hint: "收件与发信" },
  { id: "rules", label: "规则", hint: "关键词与 AI" },
  { id: "templates", label: "模板", hint: "回复内容" },
  { id: "logs", label: "日志", hint: "收件与任务" },
  { id: "settings", label: "设置", hint: "AI 与安全" },
];

const TITLES: Record<Page, string> = {
  dashboard: "概览",
  mailboxes: "邮箱管理",
  rules: "自动回复规则",
  templates: "回复模板",
  logs: "收发日志与任务",
  settings: "系统设置",
};

export default function App() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<Page>("dashboard");

  const loadMe = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<MeResponse>("/me");
      setMe(result);
      setError(null);
    } catch (err) {
      setMe(null);
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="正在验证访问权限…" />
      </div>
    );
  }

  if (!me) {
    return <LoginScreen message={error || "需要登录"} onDone={loadMe} />;
  }

  return (
    <div className="flex min-h-screen bg-slate-50">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-sm font-bold text-white">
            AR
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-800">Auto Reply</div>
            <div className="text-[11px] text-slate-400">Cloudflare Workers</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 px-2.5 py-2">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setPage(item.id)}
              className={
                "flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors " +
                (page === item.id
                  ? "bg-indigo-50 font-medium text-indigo-700"
                  : "text-slate-600 hover:bg-slate-50")
              }
            >
              <span>{item.label}</span>
              <span className="text-[10px] text-slate-400">{item.hint}</span>
            </button>
          ))}
        </nav>
        <div className="border-t border-slate-100 p-4 text-[11px] leading-5 text-slate-400">
          <div className="truncate">{me.user.email}</div>
          <div>
            {me.access.configured ? "Cloudflare Access 已启用" : me.access.devMode ? "本地开发模式" : "Access 未配置"}
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur md:px-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h1 className="text-base font-semibold text-slate-800">{TITLES[page]}</h1>
              <Badge tone={me.user.role === "admin" ? "indigo" : "slate"}>{me.user.role}</Badge>
            </div>
            <div className="flex items-center gap-2">
              <span className="hidden text-xs text-slate-500 sm:inline">{me.user.email}</span>
              <Button variant="outline" size="sm" onClick={() => void loadMe()}>
                刷新
              </Button>
            </div>
          </div>
          <div className="mt-2 flex gap-1 overflow-x-auto md:hidden">
            {NAV.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setPage(item.id)}
                className={
                  "shrink-0 rounded-full px-3 py-1 text-xs " +
                  (page === item.id
                    ? "bg-indigo-600 text-white"
                    : "bg-slate-100 text-slate-600")
                }
              >
                {item.label}
              </button>
            ))}
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8">
          {page === "dashboard" ? <DashboardPage onNavigate={setPage} /> : null}
          {page === "mailboxes" ? <MailboxesPage /> : null}
          {page === "rules" ? <RulesPage /> : null}
          {page === "templates" ? <TemplatesPage /> : null}
          {page === "logs" ? <LogsPage /> : null}
          {page === "settings" ? <SettingsPage /> : null}
        </main>
      </div>
    </div>
  );
}

function LoginScreen({ message, onDone }: { message: string; onDone: () => void }) {
  const [email, setEmail] = useState(getDevUser());

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-sm font-bold text-white">
            AR
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-800">Auto Reply</div>
            <div className="text-[11px] text-slate-400">Cloudflare Workers</div>
          </div>
        </div>

        <div className="space-y-2 text-sm text-slate-600">
          <p className="font-medium text-slate-800">未通过 Cloudflare Access 验证</p>
          <p className="text-xs leading-5 text-slate-500">{message}</p>
        </div>

        <div className="mt-5 space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs font-medium text-amber-800">本地开发登录</p>
          <p className="text-[11px] leading-4 text-amber-700">
            仅在 ENVIRONMENT=development 时有效。生产环境请通过 Cloudflare Access 访问本页面。
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Button
              onClick={() => {
                setDevUser(email.trim());
                onDone();
              }}
              disabled={!email.trim()}
            >
              进入
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
