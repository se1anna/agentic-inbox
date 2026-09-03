# Cloudflare Workers Serverless Post Office (Agentic Inbox)

<div align="center">
  <h3>基于 Cloudflare Workers Serverless 的全功能电子邮箱邮局系统</h3>
  <p>Cloudflare Email Routing + Cloudflare D1 SQL + Cloudflare Email Sending + 外部 OAuth 强鉴权 + 自定义大模型 AI 驱动 + 全功能 i18n 多语言</p>
</div>

---

## 🌟 系统架构概览 (Architecture)

本系统是一套完全运行在 Cloudflare 边缘计算（Serverless）上的企业级全功能邮局系统。前端采用 **React 19 + React Router v7 + Tailwind CSS**，后端采用 **Cloudflare Workers (Hono) + Cloudflare D1 (SQLite) + Cloudflare R2 + Cloudflare Email Sending** 原生能力。

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              浏览器前端 (React 19 SPA)                                 │
│  - 外部 OAuth 统一登录    - 邮箱别名切换与独立管理        - 富文本编辑器与邮件发送     │
│  - 自定义 AI 提供方设置   - 多语言国际化 (中/英即时切换)  - 交互式 AI 邮件助手侧栏     │
└───────────────────────────┬────────────────────────────────────────────────────────────┘
                            │ HTTPS / API
                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              Cloudflare Worker (Hono)                                  │
│                                                                                        │
│  [强制 OAuth 鉴权与 Admin 角色控制]                                                    │
│   ├── 基于 D1 `sessions` 与 `users` 表校验 Session Token                               │
│   └── 严格强制检查: 仅允许具备 `role === "Admin"` 权限的账户登入与调用 API             │
│                                                                                        │
│  [API 核心路由]                                                                        │
│   ├── /api/v1/auth/*       (登录跳转、回调验证、当前个人信息获取 /me、退出)            │
│   ├── /api/v1/user/*       (自定义 AI 端点/密钥配置、AI 连通性实时测试)               │
│   ├── /api/v1/mailboxes/*  (多别名 CRUD、文件夹管理、邮件收发、高级检索)               │
│   └── /api/v1/mailboxes/:id/agent/chat (基于自定义 AI 的交互式邮件智能体)             │
│                                                                                        │
│  [邮件事件监听器: email(event, env, ctx)]                                              │
│   ├── 0 成本收件人白名单匹配 (未注册别名直接丢弃)                                     │
│   ├── PostalMime 解析邮件载荷与防爆仓截断 (单邮件 10MB，附件 5MB，正文 200KB)          │
│   ├── 附件自动安全存入 Cloudflare R2，主体存入 D1                                      │
│   └── ctx.waitUntil 异步触发自定义 AI 后台智能起草草稿 (内置注入扫描与账单熔断)        │
└─────────────┬───────────────────────────┬───────────────────────────────┬──────────────┘
              │                           │                               │
              ▼                           ▼                               ▼
      ┌───────────────┐           ┌───────────────┐               ┌───────────────┐
      │ Cloudflare D1 │           │ Cloudflare R2 │               │  Send Email   │
      │ 关系型数据库  │           │  (附件存储)   │               │   (发信绑定)  │
      └───────────────┘           └───────────────┘               └───────────────┘
```

---

## 🚀 核心特性与系统重构

### 1. 强制性外部 OAuth 鉴权与 Admin 权限管控
- 支持对接任何标准的 OAuth 2.0 / OIDC 身份提供商（Keycloak, Authentik, Auth0, GitHub, Google, 自建 OAuth 服务等）。
- **硬性权限卡口**：系统严格限制只有拥有 `Admin` 角色的账户才能登入系统与调用后端 API。非 Admin 账户登入时返回 `403 Forbidden`。
- **首次登录自动开户**：首次登录成功后，系统自动以 OAuth 回传的邮箱地址为前缀创建用户的首个默认邮箱别名。

### 2. Cloudflare D1 关系型数据库存储
- 彻底摒弃传统 Durable Objects 绑定，全量收发邮件、会话线程（Thread）、自定义文件夹、用户档案、Session 及附件元数据全部持久化存储在 Cloudflare D1 SQLite 数据库中。
- 提供高效的会话树聚合、未读数统计与关键词检索。

### 3. 原生邮件路由与发信服务
- **收信 (Inbound)**：通过 Cloudflare Email Routing 将来信路由至 Worker，自动解析 MIME 并投递至对应的别名收件箱。
- **发信 (Outbound)**：基于 Cloudflare Email Workers 原生 `send_email` 绑定（`env.EMAIL.send(...)`）直接向公网投递邮件，严格遵守 RFC 2822 会话规范（自动写入 `In-Reply-To`、`References` 与 `Message-ID`）。

### 4. 用户可自由配置的自定义 AI 提供方 (Custom AI Provider)
- 彻底解耦内置模型限制，用户可在 **系统设置** 中自由填入 **OpenAI 兼容 API 端点**（如 OpenAI, OpenRouter, DeepSeek, Ollama, OneAPI, 自建代理）、**API Key** 与 **模型名称**。
- **AI 智能驱动两大场景**：
  1. **后台自动起草回复**：来信入库后，后台异步调用用户配置的大模型，自动分析来信意图并在对应会话的草稿箱中生成优质回复建议。
  2. **侧边栏 AI 邮件助手**：支持在侧栏对话框下达自然语言指令，AI 配备了 9 个邮箱专属工具（查信、读邮件、读上下文、精准搜索、写草稿、标记已读、移至文件夹等）。

### 5. 多邮箱别名管理与全局防抢占机制 (Anti-Hijacking)
- 一个账户可创建并管理多个独立的邮箱别名（如 `support@n0v.top`、`billing@n0v.top`、`dev@n0v.top`）。
- **防抢占保证**：邮箱别名全局唯一。任何尝试创建或篡改已被他人占用的别名请求均会被拒绝（409 Conflict）。
- 每个别名拥有独立的收件箱、发件箱、草稿箱、发件人名称与专属 AI System Prompt。

### 6. i18n 国际化多语言支持
- 内置轻量、响应式的 i18n 模块，已完整适配 **简体中文 (zh-CN)** 与 **English (en)**。
- 支持在 **系统设置（Settings）** 顶部一键即时切换界面语言，并通过 `localStorage` 自动持久化保存。

### 7. 提示词注入防护与 5 重防 Spam / 防爆仓熔断
- **5 层提示词注入防御**：结构化 XML 数据隔离定界符（`<untrusted_email_content>`）、系统元指令强约束、注入启发式扫描器、Human-in-the-Loop 人类在环（AI 仅能存草稿，绝不能未经确认直发外网）。
- **5 重防爆仓熔断机制**：未建别名 0 成本丢弃、单发件人小时级限流（最多 30 封/小时）、单邮件（10MB）与附件（5MB/最多3个）物理硬配额、正文截断（200KB）、批量/机器人邮件跳过 AI 调用以节省 API Token 账单。

---

## 🛠️ 快速上手与配置

详细安装、配置与使用说明请参阅 👉 **[完整的系统使用手册 (USAGE.md)](./USAGE.md)**。

```bash
# 1. 克隆项目并安装依赖
npm install

# 2. 复制配置模板并填入你的 D1 / OAuth 信息
cp wrangler.jsonc.example wrangler.jsonc

# 3. 初始化 D1 数据库表结构
npx wrangler d1 execute mail-db --remote --file=migrations/0001_init.sql

# 4. 创建 R2 附件存储桶
npx wrangler r2 bucket create agentic-inbox-attachments

# 5. 构建并发布上线
npm run build
npm run deploy
```

---

## 📂 项目目录结构

```
├── app/                        # React 19 前端工程 (React Router v7 + Tailwind CSS)
│   ├── components/             # UI 组件 (Header, Sidebar, ComposeEmail, AgentPanel 等)
│   ├── hooks/                  # 自定义 React Hooks (useComposeForm, useUIStore)
│   ├── i18n/                   # 国际化模块与中英文词条包 (locales/en.ts, locales/zh-CN.ts)
│   ├── queries/                # TanStack React Query 异步请求管理
│   ├── routes/                 # 页面路由 (Home/别名列表, Login, Settings, EmailList, Search)
│   ├── services/api.ts         # 前端 API 客户端封装与全局错误捕获
│   └── types/                  # 前端 TypeScript 类型定义
│
├── workers/                    # Cloudflare Workers Serverless 后端
│   ├── auth/                   # OAuth 2.0 PKCE 客户端、Session 校验与 Admin 鉴权中间件
│   ├── db/                     # Cloudflare D1 数据库 Schema 与 D1MailboxService 查询引擎
│   ├── lib/                    # 自定义 AI 客户端、邮件防注入扫描、MIME 与附件处理
│   ├── routes/                 # Hono 路由 (Auth, User Settings, Mailboxes, Emails, Agent)
│   ├── inbound-email.ts        # Cloudflare Email Routing 收信处理器 (含反 Spam 熔断)
│   ├── email-sender.ts         # Cloudflare Email Sending 发信处理器
│   └── app.ts                  # Worker 入口文件 (含 HTTP Fetch & Email Worker 导出)
│
├── migrations/                 # D1 数据库 SQL 迁移文件
│   └── 0001_init.sql           # 初始化表结构定义 (users, sessions, mailboxes, folders, emails, attachments)
│
├── wrangler.jsonc.example      # 脱敏的 Wrangler 配置文件模板
├── USAGE.md                    # 详尽的配置与使用手册
└── README.md                   # 项目概览说明
```

---

## 📄 开源许可证

本项目基于 Apache 2.0 License 开源。
