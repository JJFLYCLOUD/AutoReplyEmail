# Auto Reply Email

基于 **Cloudflare Workers 免费版** 的多邮箱自动回复系统。

支持 Cloudflare Email Routing、IMAP / POP3 收信，SMTP / Resend / Mailgun 发信；按关键词匹配模板，可选 AI 润色或 AI 分类；管理后台通过 **Cloudflare Access** 登录。

适合个人或小团队自建多邮箱自动回复，不依赖第三方 SaaS。

> 免费版即可运行：不使用 Queues / Durable Objects，任务由 D1 outbox + Cron 驱动。

---

## 功能

- **多邮箱管理**：一个后台管理多个 Cloudflare 域名邮箱、Gmail、自定义 IMAP / POP3 邮箱。
- **Cloudflare Email Routing 入站**：使用 `message.reply()` 免费即时回复，自动保持邮件线程。
- **IMAP / POP3 入站**：Cron 增量拉取，支持 TLS / STARTTLS、UID / UIDL 去重。
- **多通道发信**：Cloudflare 原生回复、SMTP、Resend、Mailgun。
- **关键词规则**：主题 / 正文 / 发件人 / 域名 / 头部 / 正则，支持优先级。
- **模板系统**：变量、条件块、纯文本 + HTML、多语言、预览。
- **AI 回复**：Workers AI 或 OpenAI 兼容 API；支持 AI 润色、AI 选择模板、失败回退模板。
- **防循环**：RFC 3834、Auto-Submitted、Precedence、List-Id、退信、References 上限、发件人冷却、线程上限、抑制名单。
- **可观测**：收发日志、原始 `.eml`、任务队列、重试、审计日志。
- **安全**：凭据 AES-256-GCM 加密、Cloudflare Access JWT 校验、Origin 校验、敏感字段不回传。

---

## 架构

```text
Browser ──► Worker fetch（Hono API + React 静态资源）
                │  ▲ Cloudflare Access
                ▼
              D1（配置 / 日志 / 任务）
                ▲
Email Routing ─► Worker email ──► 规则匹配 ──► message.reply()（即时）
                                   └─► D1 jobs（需要 SMTP/API 时）

Cron（每分钟）─► Worker scheduled ─┬─ 消费发送任务
                                   └─ 轮询 IMAP / POP3
                                         └─► SMTP / Resend / Mailgun
```

技术栈：

- TypeScript + Hono + Zod
- React 19 + Vite + Tailwind CSS
- D1 + R2
- `postal-mime` / `mimetext` / `worker-mailer`
- Cloudflare Access + `jose`
- Vitest

---

## 免费版限制

| 能力 | 说明 |
|---|---|
| CF 邮箱回复 | `message.reply()` 只能**即时**回复；要求同域、DMARC 通过、References ≤100 |
| CF Email Sending | 免费版不能向任意收件人发信，因此未启用 `send_email` binding |
| 队列 | 无 Queues，使用 D1 `jobs` + Cron，失败指数退避重试 |
| CPU | 10ms/次；已做头部优先、单封处理、正文截断 |
| 延迟回复 | CF 邮箱不支持；IMAP / SMTP / API 邮箱支持 1–86400 秒延迟 |
| IMAP / POP3 延迟 | 约 1–5 分钟（Cron 轮询） |

> 升级 Workers Paid 后，可以替换为 Queues / Durable Objects，并启用 Cloudflare Email Sending；业务层接口已隔离。

---

## 部署（Cloudflare 控制台点击版）

### 准备

- GitHub 仓库已推送
- 域名已托管在同一个 Cloudflare 账号
- 决定使用哪个域名或子域，例如 `auto-reply.example.com`

### 1. 创建 D1

Dashboard → **Workers & Pages** → **D1 SQL Database** → **Create**

- 名称：`auto-reply-db`
- 创建后复制 **Database ID**

### 2. 创建 R2

Dashboard → **R2 Object Storage** → **Create bucket**

- 名称必须是：`auto-reply-raw`

### 3. 修改仓库

把 `wrangler.jsonc` 里的占位 ID 换成真实的 D1 ID：

```jsonc
"database_id": "粘贴你的 D1 Database ID"
```

提交并推送。

> `wrangler.jsonc` 已设置 `"keep_vars": true`，因此 Dashboard 中添加的变量不会被下一次部署删除。

### 4. 用 Workers Builds 导入 GitHub

Dashboard → **Workers & Pages** → **Create application** → **Workers** → **Import a repository**

选择仓库和分支，填写：

| 配置 | 值 |
|---|---|
| Root directory | `/` |
| Build command | `npm ci && npm run build:client` |
| Deploy command | `npx wrangler d1 migrations apply auto-reply-db --remote && npx wrangler deploy` |
| 环境变量 | `NODE_VERSION=22` |

点击 **Deploy**。首次部署会同时执行数据库迁移。

> 如果 Deploy command 没有 D1 权限，改成 `npx wrangler deploy`，然后本地执行：
>
> ```bash
> npx wrangler d1 migrations apply auto-reply-db --remote
> ```
>
> 或者在 D1 → **Console** 依次执行 `migrations/` 下的三个 SQL 文件。

### 5. 绑定自定义域名

Worker → **Settings** → **Domains & Routes** → **Add** → **Custom domain**

例如：

```text
auto-reply.example.com
```

> `workers.dev` 不能使用 Cloudflare Access，管理后台必须使用自定义域名。

### 6. 创建 Cloudflare Access

Zero Trust → **Access** → **Applications** → **Add an application** → **Self-hosted**

- Domain：`auto-reply.example.com`
- Path：`/*`
- Policy：Allow → Emails → 你的邮箱（或 One-time PIN / Google / GitHub）

记录：

- 应用 Overview 里的 **Application Audience (AUD)**
- Zero Trust → Settings 里的 **Team domain**，例如 `yourteam.cloudflareaccess.com`

### 7. 设置变量与密钥

Worker → **Settings** → **Variables and Secrets**，添加：

| 名称 | 类型 | 说明 |
|---|---|---|
| `CREDENTIAL_KEY` | Secret | 32 字节随机 Base64，用于加密邮箱凭据 |
| `BOOTSTRAP_ADMIN_EMAIL` | Secret / Var | 你的 Access 登录邮箱 |
| `ACCESS_TEAM_DOMAIN` | Var | `yourteam.cloudflareaccess.com` |
| `ACCESS_AUD` | Var | 上一步复制的 AUD |

生成密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

> 生产环境不要设置 `DEV_AUTH_EMAIL`。  
> `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` 已从 `wrangler.jsonc` 移除，避免部署时被空值覆盖；请在 Dashboard 配置，保存后立即生效。  
> `CREDENTIAL_KEY` 更换后，之前保存的邮箱密码将无法解密。

### 8. 开启 Email Routing

Dashboard → **Email** → **Email Routing** → 启用域名

Routes 添加：

```text
support@example.com  →  Send to a Worker → auto-reply-email
```

或 catch-all：

```text
*@example.com  →  Send to a Worker → auto-reply-email
```

⚠️ 如果域名的 MX 已经指向 Google Workspace / Microsoft 365 / 其他邮件服务，直接启用 Email Routing 会替换 MX，导致原有邮箱收不到信。  
这种情况请使用子域，例如 `reply.example.com`，邮箱地址使用 `support@reply.example.com`。

### 9. 首次使用

1. 打开 `https://auto-reply.example.com`
2. 通过 Cloudflare Access 登录
3. 添加邮箱：
   - **Cloudflare 域名邮箱**：入站 Cloudflare Email Routing，发信 Cloudflare 原生回复
   - **Gmail**：IMAP `imap.gmail.com:993` + SMTP `smtp.gmail.com:465`，使用应用专用密码
4. 点击「测试收信」「测试发信」
5. 从外部邮箱发信，在「日志」查看回复状态

---

## 本地开发

### 1. 安装

```bash
npm install
cp .dev.vars.example .dev.vars
```

编辑 `.dev.vars`：

```dotenv
CREDENTIAL_KEY=<openssl rand -base64 32>
BOOTSTRAP_ADMIN_EMAIL=you@example.com
ENVIRONMENT=development
DEV_AUTH_EMAIL=you@example.com
```

### 2. 初始化本地 D1

```bash
npm run db:migrate:local
```

### 3. 启动

```bash
npm run dev
```

- 管理后台：<http://localhost:5173>
- Worker API：<http://127.0.0.1:8787>
- 本地登录：使用 `DEV_AUTH_EMAIL`，或页面上的开发登录输入框

> Workers AI binding 在本地 `wrangler dev` 默认不可用；AI 功能建议部署后验证。关键词 + 模板回复可以完整本地测试。

### 4. 检查

```bash
npm run typecheck
npm test
npm run build
```

### 5. 本地端到端脚本

需要 `wrangler dev` 正在运行：

```bash
node scripts/dev-smoke.mjs
node scripts/dev-pipeline-test.mjs
```

IMAP / POP3 客户端可以用内置假服务器验证（假服务器会占用终端，请另开终端执行测试脚本）：

```bash
# 终端 A：IMAP 假服务器
npm run fake:imap

# 终端 B：IMAP 测试
node scripts/dev-imap-test.mjs
node scripts/dev-imap-poll-test.mjs

# 停止 IMAP 假服务器后，终端 A 启动 POP3 假服务器
npm run fake:pop3

# 终端 B：POP3 测试
node scripts/dev-pop3-poll-test.mjs
```

---

## Gmail 接入

1. Google 账号开启**两步验证**
2. 生成**应用专用密码**（Google Account → Security → App passwords）
3. Gmail 设置 → Forwarding and POP/IMAP → 启用 IMAP
4. 后台添加邮箱：
   - 入站：IMAP，`imap.gmail.com:993`，TLS，用户名 Gmail 地址，密码填应用专用密码
   - 发信：SMTP，`smtp.gmail.com:465`，隐式 TLS，同样使用应用专用密码

> Gmail SMTP 从 Cloudflare 出口 IP 发信可能被风控；失败时可改用 Resend / Mailgun。

---

## 使用说明

### 邮箱

- 一个邮箱可以有一个入站通道（CF Routing / IMAP / POP3）。
- 可以配置多个发信通道；`reply_via` 决定优先使用哪个。
- CF 邮箱建议再配置一个 SMTP / API 通道作为兜底。

### 规则

- 关键词同时匹配主题和正文，支持“任一命中 / 全部命中”。
- 高级条件支持 JSON：

```json
{
  "any": [
    { "field": "from", "op": "domain_in", "values": ["customer.com"] },
    { "field": "header:x-tag", "op": "equals", "value": "vip" }
  ]
}
```

- 支持冷却时间、同一会话回复上限、每日上限、业务时间、延迟发送。
- AI 模式：
  - `off`：只用模板
  - `polish`：AI 润色模板
  - `classify`：AI 在模板中选择

### 模板变量

```text
{{sender_name}} {{sender_email}} {{subject}} {{date}}
{{mailbox}} {{mailbox_name}} {{quoted_body}} {{ai_text}}
{{#if ai_text}}...{{/if}}
```

### 日志与任务

- 入站 / 出站记录、状态、原始邮件、重发。
- D1 outbox 任务队列，可手动重试、立即执行。
- 失败任务按 `1m → 5m → 15m → 1h → 6h` 退避。

---

## 防循环策略

以下情况默认不回复：

- `Auto-Submitted` 不是 `no`
- `Precedence: bulk / list / junk`
- `List-Id` / `List-Unsubscribe` / `List-Post`
- `X-Auto-Response-Suppress`
- `Return-Path: <>`、`multipart/report`、退信主题
- `no-reply` / `mailer-daemon` / `postmaster` 发件人
- 发件人是邮箱自身
- `References` 超过 100 条
- 抑制名单
- 同一发件人冷却（默认 24 小时）
- 同一线程回复上限（默认 1 次）
- 单规则每日上限（默认 50）
- 邮箱每日发信上限（默认 500）

发出的回复统一带：

```text
Auto-Submitted: auto-replied
X-Auto-Response-Suppress: All
```

---

## 项目结构

```text
src/
├─ worker/
│  ├─ index.ts                 # fetch / email / scheduled
│  ├─ routes/api.ts            # REST API
│  ├─ services/                # 规则、模板、AI、限流、任务、清理
│  ├─ adapters/
│  │  ├─ inbound/cf-routing.ts
│  │  ├─ inbound/imap.ts
│  │  ├─ inbound/pop3.ts
│  │  └─ outbound/{cf-reply,smtp,resend,mailgun}.ts
│  └─ lib/                     # 加密、MIME、IMAP / POP3 客户端
├─ web/                        # React 管理后台
migrations/                    # D1 迁移
scripts/                       # 本地端到端测试与假服务器
public/                        # 静态资源 / _headers
wrangler.jsonc
```

数据库表：

`users`、`mailboxes`、`inbound_channels`、`outbound_channels`、`rules`、`templates`、`messages`、`send_log`、`reply_ledger`、`suppressions`、`jobs`、`ai_usage`、`pop3_seen`、`audit_log`、`settings`。

---

## 常见问题

**Q：部署后打开页面，/api 全部 401？**  
检查 Worker 变量 `ACCESS_TEAM_DOMAIN` 和 `ACCESS_AUD` 是否已配置，且 AUD 与 Access 应用一致。`workers.dev` 不支持 Access，请使用自定义域名。

**Q：报 `D1_ERROR: no such table`？**  
数据库迁移没有执行。运行 `npx wrangler d1 migrations apply auto-reply-db --remote`，或使用部署命令中的迁移步骤。

**Q：报 `database not found`？**  
`wrangler.jsonc` 的 `database_id` 还是占位值，替换成真实 D1 ID。

**Q：报 `CREDENTIAL_KEY is not configured`？**  
在 Worker Settings 添加 `CREDENTIAL_KEY` Secret。

**Q：CF 邮箱回复失败？**  
`message.reply()` 要求 DMARC 通过、同域、References ≤100。建议给该邮箱再配置 SMTP / Resend / Mailgun 作为兜底。

**Q：提示 `no_outbound_channel`？**  
IMAP / POP3 邮箱不能使用 `cf_reply`，需要配置 SMTP 或 API 发信通道。

**Q：Email Routing 启用后原有邮箱收不到信？**  
域名的 MX 被 Cloudflare 接管了。不要把已有 Google / Microsoft 邮箱的域名直接切到 Email Routing；请使用独立子域。

**Q：AI 在本地不可用？**  
`wrangler dev` 默认不支持 Workers AI binding；部署到 Cloudflare 后测试，或配置远程绑定。

**Q：POP3 会删除服务器邮件吗？**  
不会。POP3 只用 UIDL 记录已处理邮件，不会主动删除；需要保留文件夹/已读状态请使用 IMAP。

**Q：可以接入 QQ / 163 吗？**  
可以。添加 IMAP 邮箱时填对应服务器和授权码即可，发信使用对应 SMTP。

**Q：能延迟回复吗？**  
CF 原生回复只能即时；IMAP / SMTP / API 通道支持规则里的 `delaySeconds`。

---

## 成本

- Workers Free：100,000 请求/天，10ms CPU
- D1 / R2：免费额度内
- Cloudflare Access：免费 ≤50 用户
- Email Routing：入站免费
- Workers AI：免费额度（按 Neurons）
- Workers Builds：每月构建额度，具体以控制台为准

如果邮件量较大或需要更高 CPU / Queues / Email Sending，升级 Workers Paid（$5/月起）。

---

## License

MIT
