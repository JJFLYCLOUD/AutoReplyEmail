import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, api } from "./api";
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

  useEffect(() => {
    const onExpired = () => {
      setMe(null);
      setError("会话已过期，请重新登录");
    };
    window.addEventListener("auth:expired", onExpired);
    return () => window.removeEventListener("auth:expired", onExpired);
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      // ignore
    }
    setMe(null);
    setError(null);
  }, []);

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
          <div>账号密码登录</div>
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="mt-1 text-slate-500 underline underline-offset-2 hover:text-slate-700"
          >
            退出登录
          </button>
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
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/auth/login", { username: username.trim(), password });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

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
          <p className="font-medium text-slate-800">登录管理后台</p>
          <p className="text-xs leading-5 text-slate-500">{message}</p>
        </div>

        <form className="mt-5 space-y-3" onSubmit={(event) => void submit(event)}>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-600">账号</span>
            <Input
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="admin"
              autoFocus
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-600">密码</span>
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
            />
          </label>

          {error ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </div>
          ) : null}

          <Button
            type="submit"
            className="w-full"
            disabled={submitting || !username.trim() || !password}
          >
            {submitting ? "登录中…" : "登录"}
          </Button>
        </form>

        <p className="mt-4 text-[11px] leading-4 text-slate-400">
          账号密码由 Worker 变量 AUTH_USERNAME、AUTH_PASSWORD 控制。
        </p>
      </div>
    </div>
  );
}
