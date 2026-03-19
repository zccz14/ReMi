# 访谈引擎设计

## 概述

为 ReMi 实现 AI 主持人访谈引擎。本体通过与 AI 主持人的结构化对话，持续产出灵魂锚点。引擎的核心是一个 Agentic Interview 循环：AI 始终是对话驱动者，每轮输出必含新问题，通过召回已有锚点来理解本体、发现空白、检测矛盾，从而问出高价值问题。

## 设计决策

| 决策       | 选择                      | 理由                                          |
| ---------- | ------------------------- | --------------------------------------------- |
| 会话模式   | 单会话持续型              | 一个"无限访谈"房间，每次回来继续上次对话      |
| 锚点提取   | 实时自动提取              | 本体无感知，体验就是正常聊天                  |
| 上下文管理 | 滑动窗口 + 锚点摘要       | 早期对话精华保存在锚点中，不会丢失            |
| 流式输出   | SSE（Server-Sent Events） | 单向推送足够，与 Hono 兼容，比 WebSocket 简单 |
| LLM 调用   | 多步 pipeline             | 访谈主持人自身需要召回推理，单 Prompt 不够    |
| 思考过程   | 认知状态叙述推送          | 展示 AI 的思考过程增加趣味性和透明感          |

## MVP 范围

**包含：** 文字访谈、Streaming 响应、自动发现矛盾、访谈进度统计
**不包含：** 语音输入、图片输入

## Agentic Interview 循环

AI 主持人始终是对话的驱动者。会话由 AI 发起第一条消息，后续每轮 AI 输出必须包含一个新问题。

### 每轮处理流程

```
[会话初始化 / AI 的上一个问题已发出，等待用户回答]
    │
    ▼
用户回答到达
    │
    ▼
[Step 1] 锚点提取
    │  LLM 分析用户回答，输出结构化锚点 JSON
    │  写库 + 异步 embedding
    │
    ▼
[Step 2] Agentic Recall 循环
    │  ┌─→ 构造/改写 query
    │  │         ▼
    │  │   向量搜索，召回候选锚点
    │  │         ▼
    │  │   LLM 判断：已召回锚点是否"最小充分"？
    │  │    │不充分        │充分
    │  └────┘              ▼
    │                 输出：充分的锚点集合
    │
    ▼
[Step 3] 矛盾检测
    │  新提取锚点 vs 召回的已有锚点 → 标记冲突对
    │
    ▼
[Step 4] 生成回应 + 下一个问题（Streaming）
    │  综合所有信息，生成回应 + 新问题
    │  Stream 输出给前端
    │
    ▼
保存对话记录
```

### 冷启动

**冷启动（无历史消息）：** 锚点库为空时，AI 走冷启动协议：先声明边界，给选择权，用轻量级问题开场。直接执行 Step 2-4（跳过 Step 1，无用户回答可提取），通过 SSE 流式返回 AI 的第一条消息。

**恢复（有历史消息）：** AI 阅读滑动窗口内的最近消息 + Recall 锚点摘要，执行 Step 2-4 生成一条恢复性质的衔接消息（如"上次我们聊到了 X，让我们继续..."），通过 SSE 流式返回。同样跳过 Step 1。

两种情况下 `POST /interview/start` 都返回 SSE 流，前端行为一致。

### Agentic Recall 是共享能力

Agentic Recall 循环是访谈和推理共享的基础能力。区别仅在于"最小充分"的定义：

- **访谈流**：是否充分理解本体在当前话题的认知，从而问出好问题
- **推理流**：是否有足够锚点回答用户的问题

循环机制相同，`recall.ts` 作为独立模块实现。函数签名草案：

```typescript
interface RecallOptions {
  db: DrizzleInstance;
  embeddingClient: EmbeddingClient;
  chatClient: ChatClient;
  context: string; // 对话上下文摘要
  goal: string; // 当前目标（访谈 vs 推理的区别点）
  maxRounds?: number; // 默认 5
  topK?: number; // 每轮检索的 top-K，默认 10
  onNarrative?: (text: string) => void; // 思考叙述回调
}

interface RecallResult {
  anchors: SoulAnchor[]; // 最终召回的充分锚点集合
  narratives: string[]; // 所有思考叙述（按顺序）
  rounds: number; // 实际循环轮数
}

function agenticRecall(options: RecallOptions): Promise<RecallResult>;
```

`onNarrative` 回调允许调用方（engine）在每轮结束时实时推送思考叙述到 SSE 流。

## 数据模型

### 新增 messages 表

持久化对话历史。单会话持续型意味着每个 Soul 只有一个访谈会话，不需要 session_id。

| 列名       | 类型    | 约束             | 说明                                  |
| ---------- | ------- | ---------------- | ------------------------------------- |
| id         | INTEGER | PK AUTOINCREMENT | 消息 ID                               |
| role       | TEXT    | NOT NULL         | `'user'` / `'assistant'` / `'system'` |
| content    | TEXT    | NOT NULL         | 消息内容                              |
| created_at | INTEGER | NOT NULL         | 创建时间（Unix timestamp ms）         |

消息按 `id` 排序即是完整对话历史。

**Migration：** 在 `db/migrate.ts` 的 `initializeDatabase` 中新增 `CREATE TABLE IF NOT EXISTS messages` 语句，新增 Drizzle schema 定义。与现有表创建逻辑一致，对已有数据库安全（`IF NOT EXISTS`）。

### 滑动窗口实现

构造 LLM 调用的 messages 时：

1. 取最近 N 条对话消息作为直接上下文（默认 N=20，环境变量可配）
2. 在 system prompt 中注入 Agentic Recall 召回的锚点摘要
3. 早期对话精华已被提取为锚点，不会丢失

### 锚点表

沿用现有 `soul_anchors` 表，不扩展字段。MVP 不加 category 和 confidence。

### 矛盾处理

矛盾不持久化。发现矛盾后在下一轮追问解决，解决后更新锚点。矛盾是瞬态触发器。

## LLM 客户端

### Chat Completion 客户端

与现有 embedding 客户端模式一致，新增 Chat Completion 客户端：

```typescript
interface ChatClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
  chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
}
```

环境变量配置：`LLM_API_BASE`、`LLM_API_KEY`、`LLM_MODEL`。

### 各步骤 Prompt 策略

**Step 1 - 锚点提取：** 输入用户回答 + 近几轮上下文 + 已有锚点列表（去重），输出 JSON 数组 `[{ question, answer }]`。

**Step 2 - Agentic Recall 充分性判断：** 输入已召回锚点 + 对话上下文 + 当前目标，输出 `{ sufficient: boolean, nextQuery?: string, reason: string }`。

**Step 3 - 矛盾检测：** 输入新提取锚点 + 相关已有锚点，输出 `{ contradictions: [{ newAnchor, existingAnchor, description }] }`。只在有新锚点时运行。

**Step 4 - 访谈主持人：** System prompt 编码五层协议（目标/策略/状态/记忆/审计），注入召回锚点、空白区域、矛盾标记。输出自然语言：先回应用户，再提出新问题。

### Streaming 策略

Step 1-3 是内部步骤，用 `chat()` 非流式调用。Step 4 面向用户，用 `chatStream()` 流式输出。

### SSE Writer 生命周期

Engine 函数接受一个 SSE emitter 作为参数，贯穿整个处理流程：

```typescript
interface SSEEmitter {
  emitThinking(narrative: string): void;
  emitToken(content: string): void;
  emitDone(data: { messageId: number; anchorsExtracted: number }): void;
  emitError(code: string, message: string): void;
}
```

- Step 2（Agentic Recall）：每轮充分性判断完成后，调用 `emitThinking(narrative)` 推送思考叙述
- Step 4（生成回复）：`chatStream()` 的每个 token 通过 `emitToken(content)` 推送
- 流程结束时调用 `emitDone()`
- 任何步骤失败时调用 `emitError()`

`chatStream` 返回的 `AsyncIterable<string>` 只用于 Step 4 的 token 流，不承担 thinking 事件的推送。

## 思考过程推送

Agentic Recall 循环的中间状态通过 SSE 推送给前端，以"认知状态叙述"形式展示 AI 的思考过程（而非机器状态）。

在充分性判断步骤中，LLM 同时输出面向用户的思考叙述。例如：

- "让我想想...你之前提到过自己在团队中更喜欢倾听..."
- "我对你在冲突处理方面的认知还不够充分，让我再想想..."

前端用不同视觉样式展示（斜体、较淡颜色），与正式回复区分。

## API 设计

### 路由表

所有端点在 `/api/:pubKey/interview/` 下，受 auth 中间件保护，仅 owner 可访问。

| 方法 | 路径                              | 说明                                                                         |
| ---- | --------------------------------- | ---------------------------------------------------------------------------- |
| POST | `/api/:pubKey/interview/start`    | 初始化/恢复访谈，AI 发出第一条消息                                           |
| POST | `/api/:pubKey/interview/message`  | 发送用户消息，触发 Agentic Interview 循环（请求体：`{ "content": string }`） |
| GET  | `/api/:pubKey/interview/messages` | 获取对话历史（游标分页）                                                     |
| GET  | `/api/:pubKey/interview/status`   | 获取访谈状态统计                                                             |

### SSE 响应格式

`POST /interview/start` 和 `POST /interview/message` 均返回 SSE 流：

```
event: thinking
data: {"narrative": "让我回顾一下你之前提到的..."}

event: thinking
data: {"narrative": "我对这个方面的了解还不够充分..."}

event: token
data: {"content": "你"}

event: token
data: {"content": "刚才提到"}

event: done
data: {"messageId": 42, "anchorsExtracted": 2}

event: error
data: {"code": "LLM_ERROR", "message": "Failed to generate response"}
```

SSE error 事件的 code 独立于 HTTP 错误码体系，可能的值：`LLM_ERROR`、`EXTRACTION_ERROR`、`RECALL_ERROR`。

### GET /interview/messages

游标分页：`?limit=20&before=42`（before 是 message id）。

```json
{
  "data": {
    "items": [{ "id": 42, "role": "assistant", "content": "...", "created_at": 1710835200000 }],
    "hasMore": true
  }
}
```

### GET /interview/status

```json
{
  "data": {
    "totalAnchors": 15,
    "totalMessages": 42,
    "lastActiveAt": "2026-03-19T..."
  }
}
```

## 模块划分

### 新增文件

```
packages/server/src/
├── llm/
│   └── client.ts            # Chat Completion 客户端
├── interview/
│   ├── engine.ts             # Agentic Interview 主循环
│   ├── extractor.ts          # Step 1: 锚点提取
│   ├── recall.ts             # Step 2: Agentic Recall（可复用）
│   ├── contradiction.ts      # Step 3: 矛盾检测
│   └── prompts.ts            # Prompt 模板集中管理
├── routes/
│   └── interview.ts          # 访谈 API 路由
└── db/
    └── schema.ts             # 扩展：新增 messages 表
```

### 依赖关系

```
routes/interview.ts
  └── interview/engine.ts
        ├── interview/extractor.ts → llm/client.ts
        ├── interview/recall.ts → llm/client.ts + embedding/
        ├── interview/contradiction.ts → llm/client.ts
        └── interview/prompts.ts
```

`recall.ts` 不依赖访谈特有逻辑，将来推理流直接复用。

## 测试策略

| 层级           | 测试文件                             | 方式                                 |
| -------------- | ------------------------------------ | ------------------------------------ |
| LLM 客户端     | `llm/client.test.ts`                 | Mock HTTP                            |
| 锚点提取       | `interview/extractor.test.ts`        | Mock LLM，验证 prompt 构造和结果解析 |
| Agentic Recall | `interview/recall.test.ts`           | Mock LLM + embedding，验证循环终止   |
| 矛盾检测       | `interview/contradiction.test.ts`    | Mock LLM，验证矛盾识别               |
| 引擎集成       | `interview/engine.test.ts`           | Mock 子模块，验证编排逻辑            |
| API 路由       | `routes/interview.test.ts`           | Hono app + Mock 引擎，验证 SSE 流    |
| 端到端         | `test/interview-integration.test.ts` | 真实 DB + Mock LLM                   |

所有测试 mock LLM 调用，使用真实 SQLite（与现有测试模式一致）。

## 错误处理

- **LLM 调用失败**：返回 SSE `error` 事件，不中断会话。如果 Step 1 已成功写入锚点但后续步骤失败，已写入的锚点保留（来自有效用户输入，不算脏数据）
- **锚点提取失败**（JSON 解析错误）：静默跳过，不影响用户体验
- **Recall 循环超限**（默认 max 5 轮）：强制终止，用当前结果继续
- **数据库错误**：返回 500

## 已知限制（MVP 接受）

- 无并发控制：同一用户同时发多条消息可能导致竞态
- Prompt 模板硬编码：后续可改为配置化
- 覆盖率统计基于锚点数量，无语义维度划分
- 思考过程叙述质量依赖 LLM 能力
- 滑动窗口大小固定，不根据 token 数动态调整
