# Auto Reply Email

基于 **Cloudflare Workers 免费版** 的多邮箱自动回复服务。支持：

- **Cloudflare Email Routing** 入站，使用 `message.reply()` 免费即时回复
- **IMAP / POP3** 轮询（Gmail / 自定义邮箱），Cron 增量拉取
- **SMTP / Resend / Mailgun** 发信
- **关键词模板** + **AI 润色 / AI 分类**（Workers AI 或 OpenAI 兼容 API）
- 多邮箱管理、防循环、发件人冷却、线程上限、抑制名单、审计、原始邮件存储
- **Cloudflare Access** 登录管理后台（邮箱 OTP / Google / GitHub）
- 无 Queues / Durable Objects，使用 **D1 outbox + Cron** 在免费额度内运行

---

## 免费版限制

| 能力 | 说明 |
|---|---|
| CF 邮箱回复 | `message.reply()` 只能**即时**回复，必须同域且 DMARC 通过 |
| CF Email Sending | 免费版不能向任意收件人发信，因此未启用 `send_email` binding |
| IMAP | 通过 `cloudflare:sockets` 直连 993/143，Cron 每 1–5 分钟轮询 |
| 队列 | 无 Queues，D1 `jobs` 表 + Cron 消费，失败指数退避重试 |
| CPU | 10ms/次；已做头部优先、单封处理、正文截断等优化 |
| 延迟回复 | CF 邮箱不支持；IMAP/SMTP 邮箱支持 1–86400 秒延迟 |

> 升级 Workers Paid 后，可把 `jobs` 后端替换为 Queues，并启用 `send_email` 与 Durable Objects，业务代码无需重写。

---

## 技术栈

- TypeScript + Hono + Zod
- React 19 + Vite + Tailwind CSS
- D1（配置 / 日志 / 任务）+ R2（原始 `.eml`）
- `postal-mime` / `mimetext` / `worker-mailer`
- Cloudflare Access JWT 校验（`jose`）
- Vitest 单元测试

```
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
├─ web/                        # 管理后台
migrations/0001_init.sql
wrangler.jsonc
```

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

### 2. 创建 D1 / R2（本地）

```bash
npx wrangler d1 create auto-reply-db
# 将输出的 database_id 填入 wrangler.jsonc
npx wrangler r2 bucket create auto-reply-raw
npm run db:migrate:local
```

> 如果只想本地跑，D1 的 `database_id` 可以先保留占位 UUID，`--local` 会使用本地 SQLite。

### 3. 启动

```bash
npm run dev
```

- Worker API：<http://127.0.0.1:8787>
- 管理后台：<http://127.0.0.1:5173>
- 登录：任意 `DEV_AUTH_EMAIL` 或页面上的“本地开发登录”邮箱

`npm run dev` 会先构建一次前端，然后同时启动 Wrangler 和 Vite（Vite 代理 `/api` 到 8787）。

> Workers AI binding 在本地 `wrangler dev` 默认不可用；AI 功能建议部署后验证，或为 AI binding 配置远程模式。模板与关键词回复在本地可完整测试。

### 4. 测试与检查

```bash
npm run typecheck
npm test
npm run build          # 前端 + Worker dry-run 打包
```

### 5. 本地端到端脚本

```bash
# 需要 wrangler dev 正在运行
node scripts/dev-smoke.mjs
node scripts/dev-pipeline-test.mjs
```

IMAP / POP3 客户端可以用内置的假服务器验证（另开一个终端）：

```bash
# IMAP
node scripts/fake-imap.mjs 20993
node scripts/dev-imap-test.mjs
node scripts/dev-imap-poll-test.mjs

# POP3
node scripts/fake-pop3.mjs 21025
node scripts/dev-pop3-poll-test.mjs
```

这些脚本只在 `ENVIRONMENT=development` 下可用，不会影响生产。

---

## 部署

### 1. 创建资源

```bash
npx wrangler d1 create auto-reply-db
npx wrangler r2 bucket create auto-reply-raw
```

把 `database_id` 写入 `wrangler.jsonc`，然后：

```bash
npm run db:migrate:remote
```

### 2. 配置 Secrets

```bash
npx wrangler secret put CREDENTIAL_KEY
npx wrangler secret put BOOTSTRAP_ADMIN_EMAIL
```

`CREDENTIAL_KEY` 用于 AES-256-GCM 加密 SMTP/IMAP/API 凭据，**更换后旧凭据无法解密**。

`wrangler.jsonc` 中的 `vars` 配置：

```jsonc
"ACCESS_TEAM_DOMAIN": "yourteam.cloudflareaccess.com",
"ACCESS_AUD": "your-access-application-aud"
```

### 3. Cloudflare Access

1. Zero Trust → Access → Applications → Add application → Self-hosted
2. 域名填管理后台域名（例如 `auto-reply.example.com`），Path 填 `/*`
3. 添加策略：邮箱 OTP / Google / GitHub / 指定邮箱
4. 在 Workers → 设置 → Domains & Routes 中绑定自定义域名（`workers.dev` 不支持 Access）
5. 复制 Application Audience (AUD) 到 `ACCESS_AUD`

Worker 会校验 `Cf-Access-Jwt-Assertion`，首次登录且邮箱等于 `BOOTSTRAP_ADMIN_EMAIL` 的用户成为管理员。

### 4. Email Routing

1. 在 Cloudflare Dashboard → Email Routing 启用域名
2. 添加路由：目标地址（或 catch-all）→ **Send to a Worker** → 选择本 Worker
3. 管理后台添加邮箱，入站方式选择 **Cloudflare Email Routing**
4. 默认发信方式选 **Cloudflare 原生回复**（即时）

> `message.reply()` 要求入站邮件 DMARC 通过、References ≤100、回复收件人必须是原发件人、发件域必须与收件域一致。失败时如果配置了 SMTP/API 通道，会自动降级。

### 5. Cron

`wrangler.jsonc` 已配置：

```jsonc
"triggers": { "crons": ["* * * * *"] }
```

- 偶数分钟：消费 D1 发送任务（每次最多 2 个）
- 奇数分钟：轮询 1 个 IMAP 账号
- 每天 03:00 UTC：清理过期原文、任务、抑制项

### 6. 部署

```bash
npm run deploy
```

---

## Gmail 接入

1. Google 账号开启**两步验证**
2. 生成**应用专用密码**（Google Account → Security → App passwords）
3. Gmail 设置 → Forwarding and POP/IMAP → 启用 IMAP
4. 管理后台添加邮箱：
   - 入站：IMAP，`imap.gmail.com:993`，TLS，用户名 Gmail 地址，密码填应用专用密码
   - 发信：SMTP，`smtp.gmail.com:465`，隐式 TLS，同样使用应用专用密码
5. 点击“测试收信”和“测试发信”

> Gmail SMTP 从 Cloudflare 出口 IP 发信可能被风控；失败时可改用 Resend/Mailgun。

---

## 管理后台

| 页面 | 功能 |
|---|---|
| 概览 | 今日收发、跳过、失败、任务数、AI 用量、最近邮件 |
| 邮箱 | 多邮箱、入站/发信通道、连接测试、测试发信 |
| 规则 | 关键词/高级 JSON、模板选择、AI 模式、冷却、线程上限、延迟 |
| 模板 | 变量、条件块、纯文本/HTML、预览 |
| 日志 | 收件/发件、状态筛选、原文查看、重发、任务队列与重试 |
| 设置 | AI 提供方/模型/额度、数据保留、抑制名单、审计、Access 状态 |

模板变量：

```text
{{sender_name}} {{sender_email}} {{subject}} {{date}}
{{mailbox}} {{mailbox_name}} {{quoted_body}} {{ai_text}}
{{#if ai_text}}...{{/if}}
```

---

## 防循环策略（默认开启）

- `Auto-Submitted` 不是 `no`
- `Precedence: bulk/list/junk`
- `List-Id` / `List-Unsubscribe` / `List-Post`
- `X-Auto-Response-Suppress`
- `Return-Path: <>`、`multipart/report`
- 退信 / 自动回复 / Out of office 主题
- `no-reply` / `mailer-daemon` / `postmaster` 发件人
- 发件人是邮箱自身
- `References` > 100
- 抑制名单
- 同一发件人冷却（默认 24h）
- 同一线程回复上限（默认 1 次）
- 单规则每日上限（默认 50）
- 邮箱每日发信上限（默认 500）

发信统一带上：

```text
Auto-Submitted: auto-replied
X-Auto-Response-Suppress: All
```

---

## 数据模型

`mailboxes`、`inbound_channels`、`outbound_channels`、`rules`、`templates`、`messages`、`send_log`、`reply_ledger`、`suppressions`、`jobs`、`ai_usage`、`pop3_seen`、`audit_log`、`settings`、`users`。

凭据字段只存 AES-256-GCM 密文（`secret_ct` / `secret_iv` / `secret_kid`），前端只返回 `hasSecret`。

---

## 常见问题

**Q：为什么 CF 邮箱不能延迟回复？**  
免费版没有 `send_email` binding 的任意收件人发信能力，`message.reply()` 必须在邮件事件内完成。需要延迟时请给该邮箱配置 SMTP/API 通道，规则里设置延迟秒数。

**Q：IMAP 收信多久一次？**  
默认 5 分钟，可在邮箱里改成 60–3600 秒。Cron 每次只处理 1 个账号，账号多时会轮转。

**Q：大邮件会超 CPU 吗？**  
超过 128KB 的邮件只解析头部和正文片段；IMAP 只取 16KB 正文。若仍频繁 `exceededCpu`，降低拉取数量或关闭 AI。

**Q：能接入 QQ / 163 吗？**  
可以，添加 IMAP 邮箱时填对应服务器与授权码即可；当前默认适配 Gmail 与标准 IMAP。

**Q：如何升级到 Paid？**  
把 `jobs` 消费替换为 Queues、启用 `send_email` binding 和 Durable Objects 即可；`JobQueue` 与 `OutboundAdapter` 接口已隔离。

---

## 路线图

- [x] M0 脚手架 / D1 / Access / 后台
- [x] M1 CF 入站 → 关键词 → `reply()` → 日志
- [x] M2 多邮箱 / 规则 / 模板 / 预览 / 测试发信
- [x] M3 IMAP + Cron + D1 任务 + SMTP
- [x] M4 Resend / Mailgun / Workers AI + POP3
- [ ] Gmail API / Microsoft Graph OAuth
- [ ] 规则 dry-run UI
- [ ] 备份导入/导出

---

## License

MIT
