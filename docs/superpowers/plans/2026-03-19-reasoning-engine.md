# 推理引擎实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现分身推理引擎，任何已认证用户向分身提问，分身通过 Batch Recall 召回锚点生成"像本体会说的话"。

**Architecture:** 独立 `reasoning/` 模块与 `interview/` 平行。核心流程：Batch Recall（多目标联合召回）→ chatStream 生成回复。会话级锚点缓存复用 `recalled_anchors` 审计字段。SSE 流式输出。

**Tech Stack:** Hono (SSE), better-sqlite3 + drizzle-orm, OpenAI-compatible Chat API (native fetch), vitest

**Spec:** `docs/superpowers/specs/2026-03-19-reasoning-engine-design.md`

---

## 文件结构

```
packages/server/src/
├── reasoning/
│   ├── engine.ts              # 推理流编排（Batch Recall → 生成回复）
│   ├── batch-recall.ts        # Batch Recall（多目标联合召回）
│   └── prompts.ts             # 分身回复 + Batch Recall 的 prompt 模板
├── routes/
│   └── reasoning.ts           # 推理 API 路由（2 端点）
├── db/
│   ├── schema.ts              # 修改：新增 reasoning_messages 表
│   └── migrate.ts             # 修改：新增建表语句
├── app.ts                     # 修改：挂载 reasoning 路由
└── types.ts                   # 修改：新增 ReasoningMessage 类型

packages/server/test/
├── reasoning/
│   ├── batch-recall.test.ts
│   └── engine.test.ts
├── routes/
│   └── reasoning.test.ts
└── db/
    └── migrate.test.ts        # 修改：验证 reasoning_messages 表

test/
└── reasoning-integration.test.ts
```

---

## Chunk 1: 基础设施（类型 + DB + Prompt 模板）

### Task 1: 扩展类型定义

**Files:**

- Modify: `packages/server/src/types.ts`

- [ ] **Step 1: 新增 ReasoningMessage 类型**

在 `types.ts` 末尾追加：

```typescript
export interface ReasoningMessage {
  id: number;
  visitor_key: string;
  role: "user" | "assistant";
  content: string;
  recalled_anchors: string[] | null;
  created_at: number;
}
```

- [ ] **Step 2: 验证编译**

Run: `npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: 无新增错误

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/types.ts
git commit -m "feat(server): add ReasoningMessage type"
```

---

### Task 2: 扩展 DB schema 和 migration

**Files:**

- Modify: `packages/server/src/db/schema.ts`
- Modify: `packages/server/src/db/migrate.ts`
- Modify: `packages/server/test/db/migrate.test.ts`

- [ ] **Step 1: 写 reasoning_messages 表测试**

在 `packages/server/test/db/migrate.test.ts` 的 `describe` 块中追加测试：

```typescript
it("should create reasoning_messages table", () => {
  const dbPath = createTmpDb();
  const db = new Database(dbPath);
  initializeDatabase(db, 1536);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
    name: string;
  }[];
  const names = tables.map((t) => t.name);
  expect(names).toContain("reasoning_messages");
  const info = db.prepare("PRAGMA table_info(reasoning_messages)").all();
  const columns = (info as { name: string }[]).map((c) => c.name);
  expect(columns).toEqual(
    expect.arrayContaining([
      "id",
      "visitor_key",
      "role",
      "content",
      "recalled_anchors",
      "created_at",
    ]),
  );
  db.close();
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run packages/server/test/db/migrate.test.ts`
Expected: FAIL — reasoning_messages 表不存在

- [ ] **Step 3: 新增 Drizzle schema 定义**

在 `packages/server/src/db/schema.ts` 末尾追加：

```typescript
export const reasoningMessages = sqliteTable("reasoning_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  visitorKey: text("visitor_key").notNull(),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  recalledAnchors: text("recalled_anchors"),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
});
```

- [ ] **Step 4: 新增 CREATE TABLE 语句**

在 `packages/server/src/db/migrate.ts` 的第一个 `db.exec()` 块中，`messages` 建表语句之后、反引号闭合之前追加：

```sql
    CREATE TABLE IF NOT EXISTS reasoning_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_key TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      recalled_anchors TEXT,
      created_at INTEGER NOT NULL
    );
```

- [ ] **Step 5: 运行测试验证通过**

Run: `npx vitest run packages/server/test/db/migrate.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/db/schema.ts packages/server/src/db/migrate.ts packages/server/test/db/migrate.test.ts
git commit -m "feat(server): add reasoning_messages table schema and migration"
```

---

### Task 3: Prompt 模板

**Files:**

- Create: `packages/server/src/reasoning/prompts.ts`

- [ ] **Step 1: 创建 Batch Recall 充分性判断 prompt**

```typescript
import type { SoulAnchor } from "../types.js";

/** Batch Recall: 多目标联合充分性判断 */
export function buildBatchRecallJudgmentPrompt(
  goals: string[],
  recalledAnchors: SoulAnchor[],
  context: string,
  visitorKey: string,
): { role: string; content: string }[] {
  const anchorList = recalledAnchors
    .map((a) => `- Q: ${a.question}\n  A: ${a.answer ?? "(未回答)"}`)
    .join("\n");

  const goalList = goals.map((g, i) => `${i + 1}. ${g}`).join("\n");

  return [
    {
      role: "system",
      content: `你是一个认知充分性评估专家。综合判断当前召回的锚点是否足以完成所有目标。

## 目标列表
${goalList}

## 已召回锚点
${anchorList || "(暂无)"}

## 对话上下文
${context}

## 提问者公钥
${visitorKey}

## 判断规则
1. 对每个目标逐一判断是否充分
2. sufficient 为 true 当且仅当所有目标都充分
3. 如果不够，给出下一个检索 query（可以跨目标）
4. 同时输出面向用户的思考叙述（narrative）

输出 JSON：
{
  "sufficient": boolean,
  "goalStatus": [{"goal": "...", "sufficient": boolean, "reason": "..."}],
  "nextQuery": "...",
  "narrative": "...",
  "reason": "..."
}`,
    },
  ];
}

/** 分身回复 system prompt */
export function buildAvatarSystemPrompt(recalledAnchors: SoulAnchor[]): string {
  const anchorSummary = recalledAnchors
    .map((a) => `- Q: ${a.question}\n  A: ${a.answer ?? "(未回答)"}`)
    .join("\n");

  return `你是本体的分身。基于本体的认知和价值观，像本体一样回答问题。

## 已知的本体认知（锚点）
${anchorSummary || "(暂无锚点，坦诚说明你还不够了解本体)"}

## 规则
1. 只基于已知锚点回答，不编造本体没有表达过的观点
2. 如果锚点不足以回答，坦诚说明"我还没有足够了解本体在这方面的想法"
3. 保持本体的表达风格（从锚点中推断）
4. 宁可说"不知道"，也不编造
5. 自然地融入对话，不要列举锚点`;
}
```

- [ ] **Step 2: 验证编译**

Run: `npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: 无新增错误

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/reasoning/prompts.ts
git commit -m "feat(server): add reasoning prompt templates"
```

---

## Chunk 2: 核心逻辑（Batch Recall + Engine）

### Task 4: Batch Recall 实现

**Files:**

- Create: `packages/server/test/reasoning/batch-recall.test.ts`
- Create: `packages/server/src/reasoning/batch-recall.ts`

- [ ] **Step 1: 写 Batch Recall 测试**

```typescript
import { describe, it, expect, vi } from "vitest";
import { batchRecall } from "../../src/reasoning/batch-recall.js";
import type { ChatClient, ChatResponse } from "../../src/llm/client.js";
import type { EmbeddingClient } from "../../src/embedding/client.js";
import type { SoulAnchor } from "../../src/types.js";

function mockChatClient(...responses: string[]): ChatClient {
  const chat = vi.fn();
  for (const r of responses) {
    chat.mockResolvedValueOnce({
      content: r,
      finishReason: "stop",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    } satisfies ChatResponse);
  }
  return {
    chat,
    chatStream: vi.fn(),
  } as unknown as ChatClient;
}

function mockEmbeddingClient(): EmbeddingClient {
  return {
    embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  };
}

describe("batchRecall", () => {
  it("should return immediately if all goals sufficient on first round", async () => {
    const onNarrative = vi.fn();
    const client = mockChatClient(
      JSON.stringify({
        sufficient: true,
        goalStatus: [
          { goal: "identity", sufficient: true, reason: "found" },
          { goal: "question", sufficient: true, reason: "found" },
        ],
        nextQuery: "",
        narrative: "我已经有足够的了解",
        reason: "all goals met",
      }),
    );

    const result = await batchRecall({
      chatClient: client,
      embeddingClient: mockEmbeddingClient(),
      searchAnchors: vi.fn().mockResolvedValue([]),
      goals: ["identity", "question"],
      context: "test context",
      onNarrative,
    });

    expect(result.sufficient).toBe(true);
    expect(result.rounds).toBe(1);
    expect(onNarrative).toHaveBeenCalledWith("我已经有足够的了解");
  });

  it("should loop until sufficient with multi-goal", async () => {
    const anchor: SoulAnchor = {
      id: "a1",
      question: "我的身份",
      answer: "工程师",
      source: "interview",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const client = mockChatClient(
      JSON.stringify({
        sufficient: false,
        goalStatus: [
          { goal: "identity", sufficient: false, reason: "need more" },
          { goal: "question", sufficient: false, reason: "need more" },
        ],
        nextQuery: "我的表达风格",
        narrative: "需要更多了解...",
        reason: "insufficient",
      }),
      JSON.stringify({
        sufficient: true,
        goalStatus: [
          { goal: "identity", sufficient: true, reason: "found" },
          { goal: "question", sufficient: true, reason: "found" },
        ],
        nextQuery: "",
        narrative: "现在了解够了",
        reason: "all met",
      }),
    );

    const result = await batchRecall({
      chatClient: client,
      embeddingClient: mockEmbeddingClient(),
      searchAnchors: vi.fn().mockResolvedValue([anchor]),
      goals: ["identity", "question"],
      context: "test",
    });

    expect(result.sufficient).toBe(true);
    expect(result.rounds).toBe(2);
    expect(result.anchors).toContainEqual(anchor);
  });

  it("should stop at maxRounds", async () => {
    const insufficientResponse = JSON.stringify({
      sufficient: false,
      goalStatus: [{ goal: "g", sufficient: false, reason: "not enough" }],
      nextQuery: "more",
      narrative: "thinking...",
      reason: "need more",
    });

    const client = mockChatClient(insufficientResponse, insufficientResponse, insufficientResponse);

    const result = await batchRecall({
      chatClient: client,
      embeddingClient: mockEmbeddingClient(),
      searchAnchors: vi.fn().mockResolvedValue([]),
      goals: ["g"],
      context: "test",
      maxRounds: 3,
    });

    expect(result.sufficient).toBe(false);
    expect(result.rounds).toBe(3);
  });

  it("should include cachedAnchors in result", async () => {
    const cached: SoulAnchor = {
      id: "cached-1",
      question: "缓存问题",
      answer: "缓存答案",
      source: "interview",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const client = mockChatClient(
      JSON.stringify({
        sufficient: true,
        goalStatus: [],
        nextQuery: "",
        narrative: "",
        reason: "ok",
      }),
    );

    const result = await batchRecall({
      chatClient: client,
      embeddingClient: mockEmbeddingClient(),
      searchAnchors: vi.fn().mockResolvedValue([]),
      goals: ["g"],
      context: "test",
      cachedAnchors: [cached],
    });

    expect(result.anchors).toContainEqual(cached);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run packages/server/test/reasoning/batch-recall.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 Batch Recall**

创建 `packages/server/src/reasoning/batch-recall.ts`：

```typescript
import type { ChatClient, ChatMessage } from "../llm/client.js";
import type { SoulAnchor } from "../types.js";
import type { EmbeddingClient } from "../embedding/client.js";
import { buildBatchRecallJudgmentPrompt } from "./prompts.js";

export interface BatchRecallOptions {
  chatClient: ChatClient;
  embeddingClient: EmbeddingClient;
  searchAnchors: (embedding: number[]) => Promise<SoulAnchor[]>;
  goals: string[];
  context: string;
  cachedAnchors?: SoulAnchor[];
  maxRounds?: number;
  topK?: number;
  onNarrative?: (text: string) => void;
}

export interface BatchRecallResult {
  anchors: SoulAnchor[];
  narratives: string[];
  rounds: number;
  sufficient: boolean;
}

export async function batchRecall(options: BatchRecallOptions): Promise<BatchRecallResult> {
  const {
    chatClient,
    embeddingClient,
    searchAnchors,
    goals,
    context,
    cachedAnchors = [],
    maxRounds = 5,
    onNarrative,
  } = options;

  const allAnchors = new Map<string, SoulAnchor>();
  for (const anchor of cachedAnchors) {
    allAnchors.set(anchor.id, anchor);
  }
  const narratives: string[] = [];
  let query = context;
  let rounds = 0;

  while (rounds < maxRounds) {
    rounds++;

    // 向量搜索
    const [embedding] = await embeddingClient.embed([query]);
    const found = await searchAnchors(embedding);
    for (const anchor of found) {
      allAnchors.set(anchor.id, anchor);
    }

    // LLM 联合判断充分性
    const messages = buildBatchRecallJudgmentPrompt(
      goals,
      Array.from(allAnchors.values()),
      context,
      "",
    );
    const response = await chatClient.chat({
      messages: messages as ChatMessage[],
      temperature: 0,
      responseFormat: { type: "json_object" },
    });

    let judgment: {
      sufficient: boolean;
      goalStatus?: { goal: string; sufficient: boolean; reason: string }[];
      nextQuery?: string;
      reason: string;
      narrative?: string;
    };
    try {
      judgment = JSON.parse(response.content);
    } catch {
      break;
    }

    if (judgment.narrative) {
      narratives.push(judgment.narrative);
      onNarrative?.(judgment.narrative);
    }

    if (judgment.sufficient) {
      return {
        anchors: Array.from(allAnchors.values()),
        narratives,
        rounds,
        sufficient: true,
      };
    }

    if (judgment.nextQuery) {
      query = judgment.nextQuery;
    } else {
      break;
    }
  }

  return {
    anchors: Array.from(allAnchors.values()),
    narratives,
    rounds,
    sufficient: false,
  };
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run packages/server/test/reasoning/batch-recall.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/reasoning/batch-recall.ts packages/server/test/reasoning/batch-recall.test.ts
git commit -m "feat(server): add batch recall for multi-goal joint retrieval"
```

---

### Task 5: 推理引擎

**Files:**

- Create: `packages/server/test/reasoning/engine.test.ts`
- Create: `packages/server/src/reasoning/engine.ts`

- [ ] **Step 1: 写推理引擎测试**

```typescript
import { describe, it, expect, vi } from "vitest";
import { ReasoningEngine } from "../../src/reasoning/engine.js";
import type { ChatResponse } from "../../src/llm/client.js";

function createMockDeps() {
  const chatClient = {
    chat: vi.fn().mockResolvedValue({
      content: JSON.stringify({
        sufficient: true,
        goalStatus: [],
        nextQuery: "",
        narrative: "思考中...",
        reason: "ok",
      }),
      finishReason: "stop",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    } satisfies ChatResponse),
    chatStream: vi.fn(async function* () {
      yield "你好";
      yield "，我是分身";
    }),
  };
  const embeddingClient = {
    embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
  };
  return { chatClient, embeddingClient };
}

describe("ReasoningEngine", () => {
  it("should run handleMessage flow", async () => {
    const { chatClient, embeddingClient } = createMockDeps();
    const events: { type: string; data: unknown }[] = [];

    const engine = new ReasoningEngine({
      chatClient,
      embeddingClient,
      getMessages: vi.fn().mockResolvedValue([]),
      saveMessage: vi.fn().mockResolvedValue(1),
      searchAnchors: vi.fn().mockResolvedValue([]),
      getCachedAnchorIds: vi.fn().mockResolvedValue([]),
      getAnchorsByIds: vi.fn().mockResolvedValue([]),
    });

    const emitter = {
      emitThinking: (n: string) => events.push({ type: "thinking", data: n }),
      emitToken: (t: string) => events.push({ type: "token", data: t }),
      emitDone: (d: unknown) => events.push({ type: "done", data: d }),
      emitError: (code: string, msg: string) => events.push({ type: "error", data: { code, msg } }),
    };

    await engine.handleMessage("你好", "visitor-pub-key", emitter);

    const tokenEvents = events.filter((e) => e.type === "token");
    expect(tokenEvents.length).toBeGreaterThan(0);

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect((doneEvent!.data as { messageId: number }).messageId).toBe(1);
  });

  it("should emit error on LLM failure", async () => {
    const { chatClient, embeddingClient } = createMockDeps();
    chatClient.chat.mockRejectedValue(new Error("LLM down"));

    const events: { type: string; data: unknown }[] = [];

    const engine = new ReasoningEngine({
      chatClient,
      embeddingClient,
      getMessages: vi.fn().mockResolvedValue([]),
      saveMessage: vi.fn().mockResolvedValue(1),
      searchAnchors: vi.fn().mockResolvedValue([]),
      getCachedAnchorIds: vi.fn().mockResolvedValue([]),
      getAnchorsByIds: vi.fn().mockResolvedValue([]),
    });

    const emitter = {
      emitThinking: vi.fn(),
      emitToken: vi.fn(),
      emitDone: vi.fn(),
      emitError: (code: string, msg: string) => events.push({ type: "error", data: { code, msg } }),
    };

    await engine.handleMessage("test", "visitor-key", emitter);

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent!.data as { code: string }).code).toBe("LLM_ERROR");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现推理引擎**

创建 `packages/server/src/reasoning/engine.ts`：

```typescript
import type { ChatClient, ChatMessage } from "../llm/client.js";
import type { EmbeddingClient } from "../embedding/client.js";
import type { SoulAnchor } from "../types.js";
import { batchRecall } from "./batch-recall.js";
import { buildAvatarSystemPrompt } from "./prompts.js";

export interface ReasoningSSEEmitter {
  emitThinking(narrative: string): void;
  emitToken(content: string): void;
  emitDone(data: { messageId: number; recalledAnchors: string[] }): void;
  emitError(code: string, message: string): void;
}

export interface ReasoningEngineDeps {
  chatClient: ChatClient;
  embeddingClient: EmbeddingClient;
  getMessages(
    visitorKey: string,
    limit: number,
  ): Promise<{ id: number; role: "user" | "assistant"; content: string }[]>;
  saveMessage(
    visitorKey: string,
    role: "user" | "assistant",
    content: string,
    recalledAnchors?: string[],
  ): Promise<number>;
  searchAnchors(embedding: number[]): Promise<SoulAnchor[]>;
  getCachedAnchorIds(visitorKey: string): Promise<string[]>;
  getAnchorsByIds(ids: string[]): Promise<SoulAnchor[]>;
}

const WINDOW_SIZE = 20;

const DEFAULT_GOALS = [
  "我是谁，我的身份和表达风格",
  "对方是谁，我与对方的关系和沟通边界",
  "回答提问者的问题所需的认知",
];

export class ReasoningEngine {
  constructor(private deps: ReasoningEngineDeps) {}

  async handleMessage(
    content: string,
    visitorKey: string,
    emitter: ReasoningSSEEmitter,
  ): Promise<void> {
    try {
      // 保存用户消息
      await this.deps.saveMessage(visitorKey, "user", content);
      const messages = await this.deps.getMessages(visitorKey, WINDOW_SIZE);

      // 加载锚点缓存
      const cachedIds = await this.deps.getCachedAnchorIds(visitorKey);
      const cachedAnchors = cachedIds.length > 0 ? await this.deps.getAnchorsByIds(cachedIds) : [];

      // Step 1: Batch Recall
      const contextStr = messages
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n")
        .slice(-2000);

      const recall = await batchRecall({
        chatClient: this.deps.chatClient,
        embeddingClient: this.deps.embeddingClient,
        searchAnchors: (emb) => this.deps.searchAnchors(emb),
        goals: DEFAULT_GOALS,
        context: contextStr,
        cachedAnchors,
        onNarrative: (n) => emitter.emitThinking(n),
      });

      // Step 2: 生成分身回复
      const systemPrompt = buildAvatarSystemPrompt(recall.anchors);
      const chatMessages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      ];

      let fullContent = "";
      for await (const token of this.deps.chatClient.chatStream({
        messages: chatMessages,
      })) {
        fullContent += token;
        emitter.emitToken(token);
      }

      // 保存 assistant 消息 + recalled_anchors
      const anchorIds = recall.anchors.map((a) => a.id);
      const messageId = await this.deps.saveMessage(
        visitorKey,
        "assistant",
        fullContent,
        anchorIds,
      );

      emitter.emitDone({ messageId, recalledAnchors: anchorIds });
    } catch (error) {
      emitter.emitError("LLM_ERROR", error instanceof Error ? error.message : "Unknown error");
    }
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/reasoning/engine.ts packages/server/test/reasoning/engine.test.ts
git commit -m "feat(server): add reasoning engine orchestrator"
```

---

## Chunk 3: 路由与集成

### Task 6: 推理 API 路由

**Files:**

- Create: `packages/server/test/routes/reasoning.test.ts`
- Create: `packages/server/src/routes/reasoning.ts`

- [ ] **Step 1: 写路由测试**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { reasoningRoutes } from "../../src/routes/reasoning.js";
import { ConnectionManager } from "../../src/db/connection.js";
import * as fs from "fs";
import * as path from "path";

let tmpDir: string;
let connMgr: ConnectionManager;
const testPubKey = "test-pub-key";
const visitorPubKey = "visitor-pub-key";

function createTestApp(signerPubKey: string) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("signerPubKey", signerPubKey);
    c.set("role", signerPubKey === testPubKey ? "owner" : "visitor");
    c.set("connMgr", connMgr);
    c.set("embeddingClient", null);
    c.set("chatClient", null);
    await next();
  });
  app.route("/api", reasoningRoutes);
  return app;
}

describe("reasoning routes", () => {
  beforeEach(() => {
    tmpDir = path.join("test-tmp", "reasoning-routes-" + crypto.randomUUID());
    fs.mkdirSync(tmpDir, { recursive: true });
    connMgr = new ConnectionManager(tmpDir, {
      maxSize: 10,
      embeddingDimensions: 4,
    });
    connMgr.getConnection(testPubKey, { create: true });
  });

  afterEach(() => {
    connMgr.closeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /reasoning/messages -> 200 empty", async () => {
    const app = createTestApp(visitorPubKey);
    const res = await app.request(`/api/${testPubKey}/reasoning/messages`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toEqual([]);
    expect(body.data.hasMore).toBe(false);
  });

  it("GET /reasoning/messages filters by visitor_key", async () => {
    const app = createTestApp(visitorPubKey);
    const res = await app.request(`/api/${testPubKey}/reasoning/messages`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run packages/server/test/routes/reasoning.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现路由**

创建 `packages/server/src/routes/reasoning.ts`：

```typescript
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { sql, desc, inArray } from "drizzle-orm";
import { reasoningMessages, soulAnchors } from "../db/schema.js";
import { ReasoningEngine, type ReasoningSSEEmitter } from "../reasoning/engine.js";
import type { ConnectionManager } from "../db/connection.js";
import type { ChatClient } from "../llm/client.js";
import type { EmbeddingClient } from "../embedding/client.js";
import { searchSimilar } from "../embedding/index.js";
import type { SoulAnchor } from "../types.js";

function createEngine(
  conn: {
    raw: ReturnType<ConnectionManager["getConnection"]>["raw"];
    drizzle: ReturnType<ConnectionManager["getConnection"]>["drizzle"];
  },
  chatClient: ChatClient,
  embeddingClient: EmbeddingClient,
): ReasoningEngine {
  const deps = {
    chatClient,
    embeddingClient,

    async getMessages(visitorKey: string, limit: number) {
      const rows = conn.drizzle
        .select()
        .from(reasoningMessages)
        .where(sql`${reasoningMessages.visitorKey} = ${visitorKey}`)
        .orderBy(desc(reasoningMessages.id))
        .limit(limit)
        .all();
      return rows.reverse().map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
      }));
    },

    async saveMessage(
      visitorKey: string,
      role: "user" | "assistant",
      content: string,
      recalledAnchors?: string[],
    ): Promise<number> {
      const now = Date.now();
      const result = conn.drizzle
        .insert(reasoningMessages)
        .values({
          visitorKey,
          role,
          content,
          recalledAnchors: recalledAnchors ? JSON.stringify(recalledAnchors) : null,
          createdAt: now,
        })
        .run();
      return Number(result.lastInsertRowid);
    },

    async searchAnchors(embedding: number[]): Promise<SoulAnchor[]> {
      const results = searchSimilar(conn.raw, "soul_anchors_vec", embedding, 10);
      if (results.length === 0) return [];
      const ids = results.map((r) => r.id);
      return conn.drizzle
        .select()
        .from(soulAnchors)
        .where(inArray(soulAnchors.id, ids))
        .all() as SoulAnchor[];
    },

    async getCachedAnchorIds(visitorKey: string): Promise<string[]> {
      const lastAssistant = conn.drizzle
        .select({ recalledAnchors: reasoningMessages.recalledAnchors })
        .from(reasoningMessages)
        .where(
          sql`${reasoningMessages.visitorKey} = ${visitorKey} AND ${reasoningMessages.role} = 'assistant'`,
        )
        .orderBy(desc(reasoningMessages.id))
        .limit(1)
        .get();
      if (!lastAssistant?.recalledAnchors) return [];
      try {
        return JSON.parse(lastAssistant.recalledAnchors) as string[];
      } catch {
        return [];
      }
    },

    async getAnchorsByIds(ids: string[]): Promise<SoulAnchor[]> {
      if (ids.length === 0) return [];
      return conn.drizzle
        .select()
        .from(soulAnchors)
        .where(inArray(soulAnchors.id, ids))
        .all() as SoulAnchor[];
    },
  };

  return new ReasoningEngine(deps);
}

function createSSEEmitter(stream: {
  writeSSE: (message: { event: string; data: string }) => Promise<void>;
}): ReasoningSSEEmitter {
  return {
    emitThinking(narrative: string) {
      stream.writeSSE({ event: "thinking", data: narrative });
    },
    emitToken(content: string) {
      stream.writeSSE({ event: "token", data: content });
    },
    emitDone(data: { messageId: number; recalledAnchors: string[] }) {
      stream.writeSSE({
        event: "done",
        data: JSON.stringify(data),
      });
    },
    emitError(code: string, message: string) {
      stream.writeSSE({
        event: "error",
        data: JSON.stringify({ code, message }),
      });
    },
  };
}

export const reasoningRoutes = new Hono();

const messageSchema = z.object({
  content: z.string().min(1),
});

// GET /:pubKey/reasoning/messages
reasoningRoutes.get("/:pubKey/reasoning/messages", (c) => {
  const pubKey = c.req.param("pubKey");
  const visitorKey = c.get("signerPubKey");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const before = c.req.query("before") ? Number(c.req.query("before")) : undefined;

  const conn = c.get("connMgr").getConnection(pubKey);

  let query = conn.drizzle
    .select()
    .from(reasoningMessages)
    .where(sql`${reasoningMessages.visitorKey} = ${visitorKey}`)
    .orderBy(desc(reasoningMessages.id))
    .limit(limit + 1);

  if (before !== undefined) {
    query = conn.drizzle
      .select()
      .from(reasoningMessages)
      .where(
        sql`${reasoningMessages.visitorKey} = ${visitorKey} AND ${reasoningMessages.id} < ${before}`,
      )
      .orderBy(desc(reasoningMessages.id))
      .limit(limit + 1) as typeof query;
  }

  const rows = query.all();
  const hasMore = rows.length > limit;
  const items = rows
    .slice(0, limit)
    .reverse()
    .map((r) => ({
      ...r,
      recalled_anchors: r.recalledAnchors ? JSON.parse(r.recalledAnchors) : null,
      recalledAnchors: undefined,
      visitor_key: r.visitorKey,
      visitorKey: undefined,
      created_at: r.createdAt,
      createdAt: undefined,
    }));

  return c.json({ data: { items, hasMore } });
});

// POST /:pubKey/reasoning/message
reasoningRoutes.post(
  "/:pubKey/reasoning/message",
  zValidator("json", messageSchema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: result.error.message,
        },
        422,
      );
    }
  }),
  (c) => {
    const pubKey = c.req.param("pubKey");
    const visitorKey = c.get("signerPubKey");
    const { content } = c.req.valid("json");
    const chatClient = c.get("chatClient");
    const embeddingClient = c.get("embeddingClient");

    if (!chatClient || !embeddingClient) {
      return c.json(
        {
          error: "LLM_ERROR",
          message: "Chat or embedding client not configured",
        },
        500,
      );
    }

    const conn = c.get("connMgr").getConnection(pubKey);
    const engine = createEngine(conn, chatClient, embeddingClient);

    return streamSSE(c, async (stream) => {
      const emitter = createSSEEmitter(stream);
      await engine.handleMessage(content, visitorKey, emitter);
    });
  },
);
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run packages/server/test/routes/reasoning.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/reasoning.ts packages/server/test/routes/reasoning.test.ts
git commit -m "feat(server): add reasoning API routes with SSE"
```

---

### Task 7: App 集成

**Files:**

- Modify: `packages/server/src/app.ts`

- [ ] **Step 1: 挂载 reasoning 路由**

在 `packages/server/src/app.ts` 中：

1. 添加 import：

```typescript
import { reasoningRoutes } from "./routes/reasoning.js";
```

2. 在 `app.route("/api", interviewRoutes);` 之后追加：

```typescript
app.route("/api", reasoningRoutes);
```

- [ ] **Step 2: 运行全量测试**

Run: `npx vitest run`
Expected: ALL PASS（包括已有的 86 个测试 + 新增测试）

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/app.ts
git commit -m "feat(server): integrate reasoning engine into app"
```

---

### Task 8: 端到端集成测试

**Files:**

- Create: `test/reasoning-integration.test.ts`

- [ ] **Step 1: 写集成测试**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "@remi/server/app";
import { generateKeyPair, getPublicKey, sign, buildStringToSign } from "@remi/crypto";
import * as fs from "fs";
import * as path from "path";

describe("reasoning integration", () => {
  let app: ReturnType<typeof createApp>["app"];
  let connMgr: ReturnType<typeof createApp>["connMgr"];
  let ownerPrivKey: Uint8Array;
  let ownerPubKey: string;
  let visitorPrivKey: Uint8Array;
  let visitorPubKey: string;
  let tmpDir: string;

  async function signedRequest(
    method: string,
    pathStr: string,
    privKey: Uint8Array,
    pubKey: string,
    body?: string,
  ) {
    const timestamp = Date.now().toString();
    const url = new URL(pathStr, "http://localhost");
    const stringToSign = buildStringToSign(method, url.pathname, timestamp, body ?? "");
    const signature = sign(stringToSign, privKey);
    const headers: Record<string, string> = {
      "X-Public-Key": pubKey,
      "X-Timestamp": timestamp,
      "X-Signature": signature,
    };
    if (body) headers["Content-Type"] = "application/json";
    return app.request(pathStr, { method, headers, body });
  }

  beforeEach(async () => {
    tmpDir = path.join("test-tmp", "reasoning-int-" + crypto.randomUUID());
    fs.mkdirSync(tmpDir, { recursive: true });

    ownerPrivKey = generateKeyPair();
    ownerPubKey = getPublicKey(ownerPrivKey);
    visitorPrivKey = generateKeyPair();
    visitorPubKey = getPublicKey(visitorPrivKey);

    const result = createApp({ dataDir: tmpDir });
    app = result.app;
    connMgr = result.connMgr;

    // 确保 owner 的 soul 已创建
    await signedRequest("GET", `/api/${ownerPubKey}/health`, ownerPrivKey, ownerPubKey);
  });

  afterEach(() => {
    connMgr.closeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /reasoning/messages should return empty initially", async () => {
    const res = await signedRequest(
      "GET",
      `/api/${ownerPubKey}/reasoning/messages`,
      visitorPrivKey,
      visitorPubKey,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toEqual([]);
    expect(body.data.hasMore).toBe(false);
  });

  it("POST /reasoning/message without LLM config should return 500", async () => {
    const res = await signedRequest(
      "POST",
      `/api/${ownerPubKey}/reasoning/message`,
      visitorPrivKey,
      visitorPubKey,
      JSON.stringify({ content: "你好" }),
    );
    expect(res.status).toBe(500);
  });

  it("unauthenticated request should return 401", async () => {
    const res = await app.request(`/api/${ownerPubKey}/reasoning/messages`);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: 运行集成测试**

Run: `npx vitest run test/reasoning-integration.test.ts`
Expected: ALL PASS

- [ ] **Step 3: 运行全量测试确认无回归**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add test/reasoning-integration.test.ts
git commit -m "test: add reasoning engine integration test"
```
