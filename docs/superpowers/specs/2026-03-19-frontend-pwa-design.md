# Frontend PWA 设计规格

## 概述

ReMi 前端 PWA，移动优先的对话式界面。Owner 通过访谈建立灵魂锚点，Visitor 通过 QR 码扫码与分身对话。

## 技术选型

| 技术   | 选择                                   | 理由                   |
| ------ | -------------------------------------- | ---------------------- |
| 框架   | React 19 + Vite                        | 生态成熟，PWA 插件完善 |
| UI     | Tailwind CSS + shadcn/ui               | 轻量可定制，移动端友好 |
| 路由   | React Router v7                        | SPA 客户端路由         |
| 国际化 | react-i18next                          | 中英双语               |
| PWA    | vite-plugin-pwa (Workbox)              | 离线缓存 + 安装能力    |
| QR 码  | qrcode.react                           | 轻量 QR 生成           |
| 部署   | 独立静态部署 (GitHub Pages / CF Pages) | 前后端分离             |

## 包配置

新增 `packages/web/` 作为 monorepo workspace。依赖 `@remi/client`（间接依赖 `@remi/crypto`）。

### API 路径约定

所有 API 端点完整路径格式为 `/api/:pubKey/...`。ApiClient 提供 `ownerPath(path)` 方法自动注入当前 KeyStore 公钥：

- Owner 调用：`apiClient.get(apiClient.ownerPath("/anchors"))` → `GET /api/{myPubKey}/anchors`
- Visitor 调用：`apiClient.get(\`/api/${targetPubKey}/reasoning/messages\`)` → 直接传完整路径

## 页面规划

| 页面     | 路径         | 角色    | 说明                 |
| -------- | ------------ | ------- | -------------------- |
| 仪表盘   | `/`          | owner   | 统计概览 + 快捷入口  |
| 访谈     | `/interview` | owner   | AI 灵魂访谈对话      |
| 锚点管理 | `/anchors`   | owner   | 锚点列表/编辑/删除   |
| 分身对话 | `/s/:pubKey` | visitor | 与他人分身对话       |
| 设置     | `/settings`  | any     | 密钥管理、语言切换   |
| 分享     | `/share`     | owner   | QR 码生成 + 链接复制 |

## 目录结构

```
packages/web/
├── index.html
├── vite.config.ts
├── tsconfig.json
├── public/
│   ├── manifest.json
│   ├── icons/
│   └── locales/
│       ├── zh/translation.json
│       └── en/translation.json
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── lib/
│   │   ├── api-client.ts
│   │   ├── sse-client.ts
│   │   └── i18n.ts
│   ├── hooks/
│   │   ├── use-auth.ts
│   │   ├── use-chat.ts
│   │   └── use-anchors.ts
│   ├── components/
│   │   ├── ui/           # shadcn/ui
│   │   ├── chat/
│   │   │   ├── ChatView.tsx
│   │   │   ├── MessageList.tsx
│   │   │   ├── MessageBubble.tsx
│   │   │   ├── ThinkingBlock.tsx
│   │   │   └── ChatInput.tsx
│   │   ├── layout/
│   │   │   ├── AppShell.tsx
│   │   │   └── NavBar.tsx
│   │   └── common/
│   │       ├── QRCode.tsx
│   │       └── EphemeralWarning.tsx
│   └── pages/
│       ├── DashboardPage.tsx
│       ├── InterviewPage.tsx
│       ├── AnchorsPage.tsx
│       ├── AvatarChatPage.tsx
│       ├── SettingsPage.tsx
│       └── SharePage.tsx
```

## API Client

### 签名请求封装

`api-client.ts` 封装所有 HTTP 请求，自动构造 ED25519 签名。

```typescript
interface ApiClientConfig {
  baseUrl: string; // 后端 API 地址，如 https://api.remi.app
  keyStore: KeyStore; // @remi/client KeyStore 实例
}

class ApiClient {
  constructor(config: ApiClientConfig);

  // 通用签名请求
  async request<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>>;

  // 便捷方法
  async get<T>(path: string): Promise<ApiResponse<T>>;
  async post<T>(path: string, body: unknown): Promise<ApiResponse<T>>;
  async put<T>(path: string, body: unknown): Promise<ApiResponse<T>>;
  async delete(path: string): Promise<void>;
}
```

签名流程：

1. 构造 `StringToSign = METHOD\nPATHNAME\nTIMESTAMP\nBODY_HASH`
   - PATHNAME = URL pathname，**不含 query string**（如 `/api/abc123/anchors`）
   - 与后端 `hono-auth.ts` 的 `new URL(c.req.url).pathname` 一致
2. BODY_HASH = SHA-256(body) 的 base58 编码，无 body 时 hash 空字节
3. `new TextEncoder().encode(stringToSign)` 转为 Uint8Array，再 `await keyStore.sign(bytes)` 生成签名（返回 base58 签名字符串）
4. 附加 `X-Public-Key`、`X-Timestamp`、`X-Signature` 三个 header

### 浏览器端签名实现

`@remi/crypto` 包含 `node:crypto` 依赖，浏览器环境不可直接使用。前端在 `lib/signing.ts` 自行实现签名构造（约 20 行），仅使用 Web Crypto API：

```typescript
// lib/signing.ts — 浏览器环境签名工具
async function hashBody(body?: Uint8Array): Promise<string> {
  const data = body ?? new Uint8Array(0);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base58Encode(new Uint8Array(hash));
}

async function buildStringToSign(
  method: string,
  pathname: string,
  timestamp: string,
  body?: Uint8Array,
): Promise<string> {
  const bodyHash = await hashBody(body);
  return `${method}\n${pathname}\n${timestamp}\n${bodyHash}`;
}
```

`packages/web` 直接依赖 `base-x`（与 `@remi/crypto` 使用相同的 base58 库），在 `lib/signing.ts` 中引入 `base-x` 进行 base58 编码，不导入 `@remi/crypto` 的任何模块。

### SSE 流式客户端

标准 `EventSource` 不支持自定义 header 和 POST 方法。使用 `fetch` + `ReadableStream` 手工解析 SSE。

```typescript
interface SSEHandlers {
  onThinking?: (narrative: string) => void;
  onToken?: (content: string) => void;
  onDone?: (data: Record<string, unknown>) => void;
  onError?: (error: { code: string; message: string }) => void;
}

// 在 ApiClient 中扩展
async streamPost(
  path: string,
  body: unknown,
  handlers: SSEHandlers,
): Promise<void>;
```

解析逻辑：逐行读取 response body，按 `event:` 和 `data:` 前缀分发到对应 handler。

**SSE 事件 data 格式**：

| 事件       | data 格式   | 解析方式                                |
| ---------- | ----------- | --------------------------------------- |
| `thinking` | 裸字符串    | 直接使用 `data`                         |
| `token`    | 裸字符串    | 直接使用 `data`                         |
| `done`     | JSON 字符串 | `JSON.parse(data)` → `{messageId, ...}` |
| `error`    | JSON 字符串 | `JSON.parse(data)` → `{code, message}`  |

Interview done: `{messageId: number, anchorsExtracted: number}`
Reasoning done: `{messageId: number, recalledAnchors: string[]}`

SSE 边界处理：多行 data 拼接、空 data 忽略、流中断显示错误（不自动重连）。

## 身份与状态管理

### AuthContext

React Context 提供全局身份状态，应用启动时初始化 KeyStore。

```typescript
interface AuthState {
  initialized: boolean; // KeyStore 初始化完成
  publicKey: string; // base58 公钥
  isEphemeral: boolean; // 临时身份（IndexedDB 不可用）
  apiClient: ApiClient; // 已绑定 KeyStore 的 API 客户端
}
```

初始化流程：

1. `App.tsx` 挂载时调用 `keyStore.init()`
2. 创建 `ApiClient` 实例（baseUrl 从环境变量 `VITE_API_BASE` 读取）
3. 通过 `AuthContext.Provider` 向下传递
4. 若 `isEphemeral` 为 true，显示全局警告条

### 路由守卫

Owner 页面（仪表盘/访谈/锚点/分享）无需额外守卫 — 所有请求都携带 KeyStore 的公钥作为 owner pubKey。后端通过 `signerPubKey === urlPubKey` 判断角色。

前端路由中，owner 页面的 `:pubKey` 参数始终等于当前 KeyStore 公钥。

## 对话系统

### useChat Hook

访谈和分身对话共享同一套消息展示逻辑，但消息加载和发送的 API 路径不同。

```typescript
interface ChatConfig {
  // 加载历史消息
  loadMessages: (params: {
    limit?: number;
    before?: number;
  }) => Promise<{ items: Message[]; hasMore: boolean }>;
  // 发送消息（SSE 流）
  sendMessage: (content: string, handlers: SSEHandlers) => Promise<void>;
}

interface ChatState {
  messages: Message[];
  streaming: boolean;
  thinking: string | null;
  hasMore: boolean;
  error: string | null;
}
```

流式处理流程：

1. 用户点击发送 → 追加 user message 到列表
2. 创建空 assistant message 占位
3. `onThinking` → 更新 thinking 状态
4. `onToken` → 追加到 assistant message content
5. `onDone` → 更新 messageId，清除 streaming
6. `onError` → 显示错误提示 toast

### 对话 UI 组件

**ChatView** — 对话主容器，组合 MessageList + ChatInput。

**MessageList** — 消息列表，支持向上滚动加载更多（cursor 分页）。自动滚动到底部（新消息时）。

**MessageBubble** — 单条消息气泡。user 消息右对齐蓝底白字，assistant 消息左对齐灰底黑字。

**ThinkingBlock** — AI 思考过程展示。折叠式，浅色斜体，默认收起。点击展开查看完整思考叙述。

**ChatInput** — 底部固定输入区。文本输入框 + 发送按钮。streaming 时禁用发送。支持 Enter 发送、Shift+Enter 换行。

## 页面详细设计

### 仪表盘（DashboardPage）

布局：卡片式统计 + 快捷操作。

内容：

- 锚点总数（调用 `GET /api/:pubKey/anchors?limit=1` 获取 total）
- 访谈状态（调用 `GET /api/:pubKey/interview/status`）
  - 响应：`{ data: { totalAnchors: number, totalMessages: number, lastActiveAt: number | null } }`
  - `lastActiveAt` 为 Unix ms 时间戳，前端格式化为可读时间
- 快捷入口按钮：开始访谈 / 查看锚点 / 分享分身

### 访谈页面（InterviewPage）

全屏对话界面。使用 ChatView 组件。

特殊逻辑：

- 首次进入（无历史消息）→ 调用 `POST /api/:pubKey/interview/start` 触发 AI 冷启动消息
- 后续 → 调用 `POST /api/:pubKey/interview/message` 发送用户回复
- 加载历史 → `GET /api/:pubKey/interview/messages`

### 锚点管理（AnchorsPage）

卡片列表 + 搜索框。

功能：

- 列表展示所有锚点（问题 + 答案摘要）
- 搜索过滤（客户端过滤，请求 `?limit=200` 一次加载全部。若 total > 200 降级为分页展示）
- 点击卡片 → 展开编辑（inline 编辑问题和答案）
- 滑动删除 / 长按删除
- 底部 FAB 按钮：手动添加新锚点

### 分身对话（AvatarChatPage）

路径 `/s/:pubKey`，Visitor 与他人分身对话。

全屏对话界面，使用 ChatView 组件。

特殊逻辑：

- 从 URL 提取 owner 的 pubKey
- 无 `/start` 端点，直接发送消息
- 加载历史 → `GET /api/:pubKey/reasoning/messages`
- 发送 → `POST /api/:pubKey/reasoning/message`

### 设置页面（SettingsPage）

功能：

- **密钥信息**：显示当前公钥（可复制）
- **导出私钥**：点击后显示 base58 私钥（带警告提示）
- **导入私钥**：输入框 + 确认（覆盖当前密钥，需二次确认）
- **语言切换**：中文 / English 下拉选择
- **关于**：版本号、项目链接

### 分享页面（SharePage）

功能：

- 显示当前用户的分身对话链接：`https://{host}/s/{pubKey}`
- QR 码大图展示
- 复制链接按钮
- host 地址从 `window.location.origin` 获取

## 后端变更

### CORS 配置

后端 `app.ts` 需新增 CORS middleware：

```typescript
import { cors } from "hono/cors";
app.use(
  "/*",
  cors({
    origin: process.env.CORS_ORIGIN?.split(",") ?? [],
    allowHeaders: ["Content-Type", "X-Public-Key", "X-Timestamp", "X-Signature"],
    allowMethods: ["GET", "POST", "PUT", "DELETE"],
  }),
);
```

环境变量 `CORS_ORIGIN` 支持逗号分隔多个域名。

CORS 配置作为前端 plan 的一部分实施（修改 `packages/server/src/app.ts`），因为前端无法在无 CORS 的情况下工作。

## 国际化

翻译文件结构：

```
public/locales/
├── zh/translation.json   # 中文（默认）
└── en/translation.json   # English
```

语言检测优先级：localStorage 存储 > 浏览器语言 > 默认中文。

翻译范围：所有 UI 文本。后端 AI 生成的内容（对话回复、思考叙述）不做翻译。

翻译 key 顶层 namespace：

```
nav.*         # 导航栏
dashboard.*   # 仪表盘
chat.*        # 对话相关（访谈+分身共用）
anchors.*     # 锚点管理
settings.*    # 设置页
share.*       # 分享页
common.*      # 通用（确认、取消、错误提示等）
```

## PWA 配置

### manifest.json

```json
{
  "name": "ReMi - 鉴心",
  "short_name": "ReMi",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#1a1a2e",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

### Service Worker

使用 `vite-plugin-pwa` 自动生成。策略：

- 静态资源（JS/CSS/HTML）：预缓存
- API 请求：NetworkOnly（不缓存，避免缓存带签名的过期响应）
- 图片/字体：缓存优先

### 安装体验

检测 `beforeinstallprompt` 事件，在设置页面或首页提示安装。

## 环境变量

| 变量            | 用途          | 示例                   |
| --------------- | ------------- | ---------------------- |
| `VITE_API_BASE` | 后端 API 地址 | `https://api.remi.app` |

## 已知限制（MVP）

1. **无离线对话能力** — 离线时只能查看已缓存的页面，无法发送消息
2. **无推送通知** — MVP 不实现 Web Push
3. **无深色模式** — MVP 只有浅色主题
4. **无语音/图片输入** — 纯文本
5. **客户端搜索** — 锚点搜索在客户端过滤，不做服务端搜索
6. **无并发控制** — 多标签页同时操作可能冲突
7. **锚点数量上限** — 客户端搜索仅适用于 < 200 条锚点，超出需服务端搜索
8. **Owner 访问自身分身** — Owner 打开 `/s/{自己的pubKey}` 时正常工作（后端允许），视为自测分身效果

## 测试策略

| 层级     | 工具                           | 范围                             |
| -------- | ------------------------------ | -------------------------------- |
| 单元测试 | Vitest                         | api-client 签名、SSE 解析、hooks |
| 组件测试 | Vitest + React Testing Library | Chat 组件、页面渲染              |
| E2E      | 暂不实现                       | MVP 后考虑 Playwright            |

重点测试：

- API Client 签名构造的正确性
- SSE 流解析的各种边界情况
- useChat hook 的状态流转
- i18n 切换
