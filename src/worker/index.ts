import { Hono } from "hono";
import type { Env } from "./types";
import { authMiddleware } from "./services/auth";
import { createApi } from "./routes/api";
import { handleCloudflareEmail } from "./adapters/inbound/cf-routing";
import { drainJobs } from "./services/jobs";
import { pollDueAccounts } from "./services/poller";
import { runCleanup } from "./services/cleanup";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    app: c.env.APP_NAME || "Auto Reply",
    time: Date.now(),
    environment: c.env.ENVIRONMENT || "production",
  }),
);

app.use("/api/*", authMiddleware);
app.route("/api", createApi());

app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "not_found", path: c.req.path }, 404);
  }
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text("Not Found", 404);
});

app.onError((error, c) => {
  console.error("unhandled error", error);
  return c.json(
    {
      error: "internal_error",
      message: error instanceof Error ? error.message : String(error),
    },
    500,
  );
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      await handleCloudflareEmail(message, env, ctx);
    } catch (error) {
      console.error("email handler failed", String(error));
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const at = new Date(controller.scheduledTime || Date.now());
    const minute = at.getUTCMinutes();

    try {
      if (minute % 2 === 0) {
        await drainJobs(env, 2);
      } else {
        await pollDueAccounts(env, 1);
      }
      if (at.getUTCHours() === 3 && minute === 0) {
        await runCleanup(env);
      }
    } catch (error) {
      console.error("scheduled handler failed", String(error));
    }
  },
} satisfies ExportedHandler<Env>;
