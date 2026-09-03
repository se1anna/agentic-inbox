# Cloudflare Workers Serverless 邮局系统使用与配置手册 (USAGE.md)

本手册详细介绍了如何从零开始部署、配置外部 OAuth 鉴权、设置自定义大模型 AI、管理多个邮箱别名以及日常使用技巧。

---

## 目录

1. [前置准备工作](#1-前置准备工作)
2. [初始化与部署流程](#2-初始化与部署流程)
3. [Cloudflare Email Routing 规则配置](#3-cloudflare-email-routing-规则配置)
4. [外部 OAuth 身份源配置指南](#4-外部-oauth-身份源配置指南)
5. [邮箱别名管理与日常收发信](#5-邮箱别名管理与日常收发信)
6. [自定义 AI 大模型配置与使用](#6-自定义-ai-大模型配置与使用)
7. [i18n 国际化语言切换](#7-i18n-国际化语言切换)
8. [安全防护与防爆仓机制](#8-安全防护与防爆仓机制)
9. [常见问题与故障排查 (FAQ)](#9-常见问题与故障排查-faq)

---

## 1. 前置准备工作

在部署前，请确保你已拥有：
- 一个 **Cloudflare** 账户，并将你的域名（如 `yourdomain.com`）托管在 Cloudflare DNS 上。
- 域名已开启 **Cloudflare Email Routing**（电子邮箱路由）功能。
- 本地安装好 **Node.js (>= 20)** 与 **npm**。

---

## 2. 初始化与部署流程

### 第一步：创建 Cloudflare 资源

```bash
# 1. 创建 Cloudflare D1 数据库 (名称需为 mail-db)
npx wrangler d1 create mail-db

# 命令行将输出类似于：
# database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
# 记下这个 database_id。

# 2. 执行数据库初始建表迁移 (远程生产库)
npx wrangler d1 execute mail-db --remote --file=migrations/0001_init.sql

# 3. 创建 R2 附件存储桶
npx wrangler r2 bucket create agentic-inbox-attachments
```

---

### 第二步：配置 `wrangler.jsonc`

复制模板文件：
```bash
cp wrangler.jsonc.example wrangler.jsonc
```

编辑 `wrangler.jsonc`，根据你的实际情况填入以下字段：

```jsonc
{
	"$schema": "node_modules/wrangler/config-schema.json",
	"name": "agentic-inbox",
	"compatibility_date": "2025-11-28",
	"main": "./workers/app.ts",
	"observability": {
		"enabled": true
	},
	"compatibility_flags": [
		"nodejs_compat"
	],
	"vars": {
		// 允许作为邮箱后缀的域名（多个用逗号隔开）
		"DOMAINS": "yourdomain.com",

		// 你的 OAuth 2.0 / OIDC 客户端凭据与端点
		"OAUTH_CLIENT_ID": "your_client_id",
		"OAUTH_CLIENT_SECRET": "your_client_secret",
		"OAUTH_AUTH_URL": "https://auth.yourdomain.com/oauth/authorize",
		"OAUTH_TOKEN_URL": "https://auth.yourdomain.com/oauth/token",
		"OAUTH_USERINFO_URL": "https://auth.yourdomain.com/oauth/userinfo",
		"OAUTH_SCOPES": "openid profile email roles",

		// 允许登入系统的管理角色标识 (不区分大小写，如 Admin 或 administrator)
		"OAUTH_ADMIN_ROLE_VALUE": "Admin"
	},
	"send_email": [
		{
			"name": "EMAIL",
			"remote": true
		}
	],
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "mail-db",
			"database_id": "填入第一步获取到的_database_id",
			"migrations_dir": "migrations"
		}
	],
	"r2_buckets": [
		{
			"binding": "BUCKET",
			"bucket_name": "agentic-inbox-attachments",
			"preview_bucket_name": "agentic-inbox-attachments"
		}
	],
	// 【特别注意】如果你的 OAuth 认证端也是运行在同域下的 Cloudflare Worker，
	// 请开启 Service 绑定以防止 Worker-to-Worker 同域子请求触发 522 超时错误：
	"services": [
		// {
		// 	"binding": "OAUTH_SERVICE",
		// 	"service": "your-oauth-worker-name"
		// }
	]
}
```

---

### 第三步：编译与部署上线

```bash
# 编译前端生产静态资源与 SSR Bundle
npm run build

# 部署到 Cloudflare Workers
npm run deploy
```

部署完成后，命令行将输出你的访问域名（如 `https://agentic-inbox.your-name.workers.dev` 或你自定义绑定的 `https://mail.yourdomain.com`）。

---

## 3. Cloudflare Email Routing 规则配置

为了让发往你域名的邮件能够被邮局正确接收：

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2. 进入你的域名 -> 侧边栏 **Email Routing（电子邮箱路由）** -> **Routing rules（路由规则）**。
3. 找到 **Catch-all rule（全部捕获规则）** 或点击 **Add rule（添加规则）**：
   - **Action（操作）**：选择 `Send to a Worker`（发送到 Worker）。
   - **Destination Worker（目标 Worker）**：选择你刚刚部署的 Worker 名称（如 `agentic-inbox`）。
   - 点击 **Save** 保存。

> 💡 **发信权限提醒**：在 Cloudflare Dashboard 中，若使用 Email Workers 发信，请确保发件人域名已通过 SPF / DKIM 校验，并在 Email Routing 中允许该域名作为发信来源。

---

## 4. 外部 OAuth 身份源配置指南

本系统实行**强制性外部 OAuth 鉴权**，只有具备 `Admin` 管理员角色的账号被允许登入系统。

### OAuth 重定向 URI (Redirect URI)
在你的 OAuth 提供商后台注册应用时，重定向 URI 必须填入：
`https://你的邮箱访问域名/api/v1/auth/callback`
*(例如: `https://mail.yourdomain.com/api/v1/auth/callback`)*

### 常见 OAuth 身份源配置参考

#### 1. Authentik / Keycloak / Auth0 (通用 OIDC)
- **Authorization URL**: `https://auth.example.com/application/o/authorize/`
- **Token URL**: `https://auth.example.com/application/o/token/`
- **Userinfo URL**: `https://auth.example.com/application/o/userinfo/`
- **Scopes**: `openid profile email roles`
- **Role Claim**: 确保用户的 Profile 或 Token 中包含 `roles: ["Admin"]` 或 `role: "Admin"`。

#### 2. 自建 Cloudflare Worker OAuth 服务
- 若 OAuth 提供方也是一个 Cloudflare Worker，在 `wrangler.jsonc` 中配置 `"OAUTH_SERVICE"` 服务绑定（指向该 Auth Worker 的名称），即可避免边缘网络间的 522 TCP 握手超时。

---

## 5. 邮箱别名管理与日常收发信

### 1. 登录与首次开户
- 访问你的系统主页，点击 **“通过外部 OAuth 登录”**。
- 授权成功后，系统会自动以你的 OAuth 邮箱地址创建第一个默认邮箱别名。

### 2. 创建更多独立邮箱别名
- 在主页或系统设置中，点击 **“新建别名 / 添加别名”**。
- 输入前缀（如 `support`、`info`、`billing`）以及发件人显示名称（如 `技术支持团队`）。
- **防抢占机制**：邮箱别名全局唯一，一经创建即与你的账户绑定，防止跨租户劫持。

### 3. 写信与草稿管理
- 点击侧边栏 **“写邮件”** 按钮调出富文本编辑器。
- 支持抄送 (CC)、密送 (BCC)、主题与富文本排版。
- **草稿箱**：编辑过程中点击 **“存为草稿”**，草稿将完整保留并持久化同步至 D1 数据库；邮件正式发出后，对应草稿会自动清理。
- **回复 / 转发**：系统自动拼接标准 RFC 2822 引用块与 `In-Reply-To`、`References` 头部，保障邮件往来会话（Thread）的完整连贯。

---

## 6. 自定义 AI 大模型配置与使用

系统彻底摆脱了内置模型的算力限制，支持接入任何兼容 **OpenAI 标准**的大模型端点。

### 1. 配置自定义 AI 端点
1. 点击系统右上角的 **齿轮图标（系统设置）**。
2. 滚动至 **“自定义 AI 模型提供方配置”** 卡片：
   - **AI 端点 URL**：支持填入 OpenAI 官方、OpenRouter、DeepSeek、Ollama 或自建反代地址。
     - 例如: `https://api.deepseek.com/v1`
     - 例如: `https://openrouter.ai/api/v1`
     - 例如: `https://api.openai.com/v1`
   - **API Key**：填入你的大模型 API 密钥（如 `sk-...`）。
   - **模型名称**：填入具体的模型代号（如 `deepseek-chat`、`gpt-4o`、`claude-3-5-sonnet`、`gemini-2.5-flash`）。
3. 点击 **“测试连接”**，系统将实时发起握手测试。
4. 验证成功后点击 **“保存 AI 提供方”**。

---

### 2. AI 邮件智能体两大应用模式

#### 模式一：新邮件后台自动起草回复 (Auto-Drafting)
- 每当外部发来一封新邮件，系统在收件入库的同时，通过后台异步任务调用你配置的 AI 端点。
- AI 结合该邮箱设置中的专属 System Prompt 自动理解来信意图并撰写得体的回复建议，直接存入 **“草稿箱”**。
- 你打开邮件时即可看到建议草稿，点击 **“在写信窗口中编辑并发送”**，微调后即可一键发出！

#### 模式二：交互式 AI 邮件助手 (Interactive Agent)
- 点击顶部右上角的 **机器人图标** 打开 AI 助手侧边栏。
- 助手内置了 9 个专业邮箱工具，你可以直接输入自然语言指令：
  - *“帮我看一下收件箱最近有没有关于发票或账单的邮件”*
  - *“查看最新一封邮件的完整会话往来，并草拟一封礼貌的确认函”*
  - *“搜索包含‘合作’关键词的所有邮件并汇总摘要”*
  - *“把 ID 为 xxx 的邮件标记为已读并归档”*

---

## 7. i18n 国际化语言切换

系统已全量支持 **简体中文（zh-CN）** 与 **English（en）**：
- **设置内切换**：进入 **“系统设置”**，在顶部的 **“界面语言”** 卡片中点击对应按钮即可即时切换。
- **登录页切换**：登录卡片右上角提供中英文切换入口。
- 你的语言选择会通过 `localStorage` 自动持久化记忆，无需重复设置。

---

## 8. 安全防护与防爆仓机制

为防止恶意邮件轰炸拖垮 D1 数据库、耗尽 R2 存储空间或刷爆你的大模型 API 账单，系统内置了 5 重防线：

1. **未建别名 0 成本丢弃**：外部发往未在你账户下创建的随机别名的垃圾邮件，直接在最前端丢弃，不写库、不存 R2、不调 AI。
2. **单发件人限流**：同一发件人 1 小时内发信超过 **30 封** 自动熔断丢弃，彻底防御脚本轰炸。
3. **附件与邮件硬上限**：单邮件最大限制 **10MB**，单个附件限制 **5MB**（最多存储 3 个附件），超限附件跳过上传 R2。
4. **正文截断保护**：存入 D1 的邮件正文字符硬截断至 **200KB**，杜绝超大 Base64 文本攻击。
5. **AI 账单熔断与注入防御**：
   - 自动识别并跳过 `List-Unsubscribe` / `Precedence: bulk` 等机器群发邮件，不浪费 AI Token。
   - 邮件内容采用 XML 标签定界隔离（`<untrusted_email_content>`）；检测到越狱或提示词攻击特征时，**自动跳过 AI 调用**。
   - **Human-in-the-Loop 终极防线**：AI 无权直接向外网发信，所有动作必须生成为草稿由人工确认发送。

---

## 9. 常见问题与故障排查 (FAQ)

### Q1: 点击创建邮箱别名提示 `Request failed: 500`？
- **排查**：请确认是否已经执行了 D1 初始数据库迁移：
  ```bash
  npx wrangler d1 execute mail-db --remote --file=migrations/0001_init.sql
  ```

### Q2: 登录时报错 `OAuth authentication failed (HTTP 522)`？
- **原因**：如果你的 OAuth 服务本身也是托管在 Cloudflare 上的 Worker，当 `mail.n0v.top` 请求 `n0v.top` 时，Cloudflare 边缘网络会阻止同 Zone 的回环子请求导致 TCP 超时（522）。
- **解决**：在 `wrangler.jsonc` 中配置 `"services": [{ "binding": "OAUTH_SERVICE", "service": "你的OAuth-Worker名称" }]`，重新执行 `npm run deploy` 即可走 Worker 内核直连。

### Q3: 登录后提示 `403 Forbidden - Admin Role Required`？
- **原因**：你的 OAuth 账号认证成功，但其角色不是 `Admin`。
- **解决**：在你的 OAuth 身份管理系统（如 Authentik/Keycloak）中，为该用户分配 `Admin` 角色或组，或在 `wrangler.jsonc` 中修改 `"OAUTH_ADMIN_ROLE_VALUE"` 匹配你的角色名称。

### Q4: 发送邮件外部收不到？
- **排查**：
  1. 检查 Cloudflare Dashboard -> **Email Routing** 中该域名的 SPF / DKIM DNS 记录是否已配置且状态为 Active。
  2. 检查 `wrangler.jsonc` 中的 `"DOMAINS"` 是否包含了当前发信别名的后缀域名。

---

🎉 **祝你使用愉快！如需扩展更多功能（如 MCP 协议连接等），随时随地通过自然语言与开发助手协作！**
