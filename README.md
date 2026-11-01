# Auto Reply Email

基于 **Cloudflare Workers 免费版** 的多邮箱自动回复系统。

支持 Cloudflare Email Routing、IMAP / POP3 收信，SMTP / Resend / Mailgun 发信；按关键词匹配模板，可选 AI 润色或 AI 分类；管理后台使用**账号密码登录**，账号密码由 Worker 变量控制。

适合个人或小团队自建多邮箱自动回复，不依赖第三方 SaaS。

> 免费版即可运行：不使用 Queues / Durable Objects，任务由 D1 outbox + Cron 驱动。

---

## 功能

- **多邮箱管理**：一个后台管理多个 Cloudflare 域名邮箱、Gmail、自定义 IMAP / POP3 邮箱。
- **Cloudflare Email Routing 入站**：使用 `message.reply()` 免费即时回复，自动保持邮件线程。
- **IMAP / POP3 入站**：Cron 增量拉取，支持 TLS / STARTTLS、UID / UIDL 去重。
- **多通道发信**：Cloudflare 原生回复、SMTP、Resend、Mailgun。
- **关键词规则**：一条规则可绑定多个邮箱，主题 / 正文 / 发件人 / 域名 / 头部 / 正则，支持优先级。
- **域名过滤**：规则级发件人域名白名单 / 黑名单，可选包含子域名。
- **模板系统**：全局模板，所有邮箱共用；变量、条件块、纯文本 + HTML、多语言、预览。
- **AI 回复**：Workers AI 或 OpenAI 兼容 API；支持 AI 润色、AI 选择模板、失败回退模板。
- **防循环**：RFC 3834、Auto-Submitted、Precedence、List-Id、退信、References 上限、发件人冷却、线程上限、抑制名单。
- **可观测**：收发日志、原始 `.eml`、任务队列、重试、审计日志。
- **安全**：账号密码登录、HttpOnly 会话 Cookie、凭据 AES-256-GCM 加密、Origin 校验、敏感字段不回传。

---

## 架构

```text
Browser ──► Worker fetch（Hono API + React 静态资源）
                │  ▲ 账号密码会话 Cookie
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
- `jose`（会话 JWT）
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
> 或者在 D1 → **Console** 依次执行 `migrations/` 下的 SQL 文件。

### 5. 绑定自定义域名（可选）

Worker → **Settings** → **Domains & Routes** → **Add** → **Custom domain**

例如：

```text
auto-reply.example.com
```

> 不绑定自定义域名也可以使用 `https://auto-reply-email.<你的子域>.workers.dev` 登录。  
> 但 Email Routing 仍然需要一个托管在 Cloudflare 的域名。

### 6. 设置登录变量与密钥

Worker → **Settings** → **Variables and Secrets**，添加：

| 名称 | 类型 | 说明 |
|---|---|---|
| `AUTH_USERNAME` | Var | 登录账号，例如 `admin` |
| `AUTH_PASSWORD` | **Secret** | 登录密码，建议 24 位以上随机字符串 |
| `AUTH_SESSION_SECRET` | **Secret** | 会话签名密钥，32 字节随机 Base64 |
| `AUTH_SESSION_HOURS` | Var（可选） | 登录有效期，默认 `12` |
| `CREDENTIAL_KEY` | Secret | 32 字节随机 Base64，用于加密邮箱凭据 |

生成两个随机密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

> `AUTH_PASSWORD` 一定要用 Secret，不要用普通 Var。  
> 修改 `AUTH_PASSWORD` 会使已有会话失效；修改 `AUTH_SESSION_SECRET` 会让所有人退出登录。  
> `CREDENTIAL_KEY` 更换后，之前保存的邮箱密码将无法解密。

### 7. 开启 Email Routing

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

### 8. 首次使用

1. 打开 `https://auto-reply.example.com` 或 `https://auto-reply-email.<子域>.workers.dev`
2. 输入 `AUTH_USERNAME` / `AUTH_PASSWORD` 登录
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
CREDENTIAL_KEY=<32 字节随机 Base64>
AUTH_USERNAME=admin
AUTH_PASSWORD=dev-password
AUTH_SESSION_SECRET=<32 字节随机 Base64>
AUTH_SESSION_HOURS=12
ENVIRONMENT=development
```

> 本地默认账号是 `admin`，密码是 `dev-password`（仅用于开发）。  
> 修改 `AUTH_PASSWORD` 后需要重新登录。

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
- 本地登录：使用 `.dev.vars` 中的 `AUTH_USERNAME` / `AUTH_PASSWORD`

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
node scripts/dev-auth-test.mjs
node scripts/dev-features-test.mjs
node scripts/dev-single-outbound-test.mjs
node scripts/dev-inline-send-test.mjs
node scripts/dev-rule-order-test.mjs
```

IMAP / POP3 客户端可以用内置假服务器验证（假服务器会占用终端，请另开终端执行测试脚本）：

```bash
# 终端 A：IMAP 假服务器
npm run fake:imap

# 终端 B：IMAP 测试
node scripts/dev-imap-test.mjs
node scripts/dev-imap-poll-test.mjs

# 可选：模拟服务器乱序返回 TEXT / HEADER
npm run fake:imap -- --reverse-parts

# 可选：模拟 multipart/alternative + base64 正文
npm run fake:imap -- --base64-multipart

# 停止 IMAP 假服务器后，终端 A 启动 POP3 假服务器
npm run fake:pop3

# 终端 B：POP3 测试
node scripts/dev-pop3-poll-test.mjs

# 终端 A：SMTP 即时发送测试
npm run fake:smtp

# 终端 B
node scripts/dev-inline-send-test.mjs
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
- 一个邮箱只有一个发信通道，发信方式由下方配置决定。
- 规则 `delaySeconds = 0` 时，SMTP / API 会**立即发送**；发送失败才写入任务队列重试。
- 延迟发送仍然走 D1 任务队列。
- 不会自动切换通道：SMTP 失败只重试当前通道；CF 原生回复失败也不会改用 SMTP。
- 发信方式由该邮箱的出站通道直接决定，没有额外的“默认发信方式”。

### 规则

- 一条规则可以绑定一个或多个邮箱。
- 避免重复：同一规则不要绑定到多个会同时收到同一封邮件的地址。
- 关键词同时匹配主题和正文，支持“任一命中 / 全部命中”。
- 模板是全局的，所有邮箱的规则都可以使用同一套模板。
- 高级条件支持 JSON：

```json
{
  "any": [
    { "field": "from", "op": "domain_in", "values": ["customer.com"] },
    { "field": "header:x-tag", "op": "equals", "value": "vip" }
  ]
}
```

- 支持冷却时间、同一会话回复上限、业务时间、延迟发送。
- 删除邮箱时，如果规则已经没有其他绑定邮箱，规则会自动停用但不会删除。

### 发件人域名过滤

每条规则可以单独设置发件人域名过滤：

- **不限制**：所有发件人都可以命中
- **白名单**：只有列表中的域名可以命中本规则
- **黑名单**：列表中的域名不会命中本规则

选项：

- 域名不区分大小写，支持 `example.com` 或 `@example.com`
- 开启“包含子域名”时，`example.com` 也会匹配 `mail.example.com`
- 白名单为空时规则永不命中
- 黑名单只影响当前规则；全局拉黑请使用「设置 → 抑制名单」

示例：

```json
{
  "matchAll": true,
  "domainFilter": {
    "mode": "allow",
    "domains": ["customer.com", "partner.cn"],
    "includeSubdomains": true
  }
}
```
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

`users`（预留多账号）、`mailboxes`、`inbound_channels`、`outbound_channels`、`rules`、`rule_mailboxes`、`templates`（全局）、`messages`、`send_log`、`reply_ledger`、`suppressions`、`jobs`、`ai_usage`、`pop3_seen`、`login_attempts`、`audit_log`、`settings`。

---

## 常见问题

**Q：部署后打开页面，/api 全部 401？**  
先确认已经登录，或者会话没有过期。如果登录页提示“服务端未配置登录账号”，请在 Worker Settings 配置 `AUTH_USERNAME`、`AUTH_PASSWORD`、`AUTH_SESSION_SECRET`。

**Q：登录提示“账号或密码错误”？**  
检查 Worker 变量 `AUTH_USERNAME` 和 Secret `AUTH_PASSWORD`。账号区分大小写；修改密码后旧会话会失效。

**Q：忘记密码怎么办？**  
在 Worker Settings 修改 `AUTH_PASSWORD`，保存后立即生效，旧会话全部失效。密码建议使用 24 位以上随机字符串。

**Q：登录提示“尝试次数过多”？**  
同一 IP 在 15 分钟内失败 5 次会触发限流。等待窗口结束后重试，或清除 D1 表 `login_attempts` 中对应记录。

**Q：报 `D1_ERROR: no such table`？**  
数据库迁移没有执行。运行 `npx wrangler d1 migrations apply auto-reply-db --remote`，或使用部署命令中的迁移步骤。

**Q：报 `database not found`？**  
`wrangler.jsonc` 的 `database_id` 还是占位值，替换成真实 D1 ID。

**Q：报 `CREDENTIAL_KEY is not configured`？**  
在 Worker Settings 添加 `CREDENTIAL_KEY` Secret。

**Q：邮件正文是 base64 或只有 HTML，能识别关键词吗？**  
可以。解析器会递归解析 `multipart`，按 part 解码 `base64` / `quoted-printable`，优先使用 `text/plain`，没有纯文本时使用 HTML 去标签后的内容。IMAP 正文拉取上限为 32KB，POP3 为 300 行。

**Q：CF 邮箱回复失败？**  
`message.reply()` 要求 DMARC 通过、同域、References ≤100。本应用不会自动切换备用通道；失败会记录为失败，请改用 SMTP/API 通道或检查邮件条件。

**Q：提示 `no_outbound_channel`？**  
该邮箱没有配置可用的发信通道，或者 IMAP/POP3 邮箱配置了 `cf_reply`。请选择 SMTP / Resend / Mailgun。

**Q：Email Routing 启用后原有邮箱收不到信？**  
域名的 MX 被 Cloudflare 接管了。不要把已有 Google / Microsoft 邮箱的域名直接切到 Email Routing；请使用独立子域。

**Q：AI 在本地不可用？**  
`wrangler dev` 默认不支持 Workers AI binding；部署到 Cloudflare 后测试，或配置远程绑定。

**Q：POP3 会删除服务器邮件吗？**  
不会。POP3 只用 UIDL 记录已处理邮件，不会主动删除；需要保留文件夹/已读状态请使用 IMAP。

**Q：可以接入 QQ / 163 吗？**  
可以。添加 IMAP 邮箱时填对应服务器和授权码即可，发信使用对应 SMTP。

**Q：能延迟回复吗？**  
只有 SMTP / Resend / Mailgun 通道支持规则里的 `delaySeconds`。CF 原生回复只能即时；如果规则设置了延迟，CF 邮箱会跳过并记录原因，不会切换通道。

---

## 成本

- Workers Free：100,000 请求/天，10ms CPU
- D1 / R2：免费额度内
- Email Routing：入站免费
- Workers AI：免费额度（按 Neurons）
- Workers Builds：每月构建额度，具体以控制台为准

如果邮件量较大或需要更高 CPU / Queues / Email Sending，升级 Workers Paid（$5/月起）。

---

## License

MIT
