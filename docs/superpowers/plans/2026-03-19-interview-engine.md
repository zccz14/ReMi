# 访谈引擎实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 AI 主持人访谈引擎，通过 Agentic Interview 循环持续产出灵魂锚点。

**Architecture:** 多步 pipeline（锚点提取 → Agentic Recall → 矛盾检测 → 生成回复），通过 SSE 流式输出。AI 始终是对话驱动者，每轮输出包含思考叙述和新问题。

**Tech Stack:** Hono (SSE), better-sqlite3 + drizzle-orm, OpenAI-compatible Chat API (native fetch), vitest

**Spec:** `docs/superpowers/specs/2026-03-19-interview-engine-design.md`

---

## 文件结构

```
packages/server/src/
├── llm/
│   └── client.ts              # Chat Completion 客户端（chat + chatStream）
├── interview/
│   ├── engine.ts               # Agentic Interview 主循环编排
│   ├── extractor.ts            # Step 1: 锚点提取
│   ├── recall.ts               # Step 2: Agentic Recall（可复用）
│   ├── contradiction.ts        # Step 3: 矛盾检测
│   └── prompts.ts              # Prompt 模板
├── routes/
│   └── interview.ts            # 访谈 API 路由（4 端点）
├── db/
│   ├── schema.ts               # 修改：新增 messages 表定义
│   └── migrate.ts              # 修改：新增 messages 建表语句
├── app.ts                      # 修改：挂载 interview 路由 + chatClient 注入
├── index.ts                    # 修改：读取 LLM 环境变量
└── types.ts                    # 修改：新增 Message 类型 + SSE 错误码

packages/server/test/
├── llm/
│   └── client.test.ts
├── interview/
│   ├── extractor.test.ts
│   ├── recall.test.ts
│   ├── contradiction.test.ts
│   └── engine.test.ts
├── routes/
│   └── interview.test.ts
└── db/
    └── migrate.test.ts          # 修改：验证 messages 表创建

test/
└── interview-integration.test.ts  # 端到端集成测试
```

---

## Chunk 1: 基础设施（LLM 客户端 + DB 扩展 + 类型）

### Task 1: 扩展类型定义

**Files:**

- Modify: `packages/server/src/types.ts`

- [ ] **Step 1: 新增 Message 类型和 SSE 错误码**

在 `types.ts` 的 `ErrorCode` union 中追加 `"LLM_ERROR" | "EXTRACTION_ERROR" | "RECALL_ERROR"`。新增：

```typescript
export interface Message {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: number;
}
```

- [ ] **Step 2: 验证类型编译**

Run: `npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: 无新增错误

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/types.ts
git commit -m "feat(server): add Message type and SSE error codes"
```

---

### Task 2: 扩展数据库 schema 和 migration

**Files:**

- Modify: `packages/server/src/db/schema.ts`
- Modify: `packages/server/src/db/migrate.ts`
- Modify: `packages/server/test/db/migrate.test.ts`

- [ ] **Step 1: 写 messages 表测试**

在 `packages/server/test/db/migrate.test.ts` 的 `describe` 块中添加测试（使用已有的 `createTmpDb` helper）：

```typescript
it("should create messages table", () => {
  const dbPath = createTmpDb();
  const db = new Database(dbPath);
  initializeDatabase(db, 1536);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  const names = tables.map((t) => t.name);
  expect(names).toContain("messages");
  const info = db.prepare("PRAGMA table_info(messages)").all() as {
    name: string;
  }[];
  const columns = info.map((c) => c.name);
  expect(columns).toEqual(expect.arrayContaining(["id", "role", "content", "created_at"]));
  db.close();
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run packages/server/test/db/migrate.test.ts`
Expected: FAIL — messages 表不存在

- [ ] **Step 3: 在 schema.ts 中添加 messages 表 Drizzle 定义**

```typescript
export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  role: text("role", {
    enum: ["user", "assistant", "system"],
  }).notNull(),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
});
```

- [ ] **Step 4: 在 migrate.ts 的 db.exec() 中添加建表语句**

在已有的 `CREATE TABLE IF NOT EXISTS` 语句块末尾追加：

```sql
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

- [ ] **Step 5: 运行测试验证通过**

Run: `npx vitest run packages/server/test/db/migrate.test.ts`
Expected: ALL PASS

- [ ] **Step 6: 全量测试确认无回归**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/db/schema.ts \
  packages/server/src/db/migrate.ts \
  packages/server/test/db/migrate.test.ts
git commit -m "feat(server): add messages table schema and migration"
```

---

### Task 3: LLM Chat Completion 客户端

**Files:**

- Create: `packages/server/src/llm/client.ts`
- Create: `packages/server/test/llm/client.test.ts`

- [ ] **Step 1: 写 chat 非流式调用测试**

创建 `packages/server/test/llm/client.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createChatClient } from "../../src/llm/client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("ChatClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const client = createChatClient({
    apiBase: "https://api.test.com/v1",
    apiKey: "test-key",
    model: "test-model",
  });

  describe("chat", () => {
    it("should send correct request and return response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "Hello!" } }],
        }),
      });
      const result = await client.chat([{ role: "user", content: "Hi" }]);
      expect(result.content).toBe("Hello!");
      expect(result.role).toBe("assistant");
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.test.com/v1/chat/completions");
      expect(options.method).toBe("POST");
      expect(options.headers["Authorization"]).toBe("Bearer test-key");
      const body = JSON.parse(options.body);
      expect(body.model).toBe("test-model");
      expect(body.messages).toEqual([{ role: "user", content: "Hi" }]);
      expect(body.stream).toBe(false);
    });

    it("should throw on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        text: async () => "Rate limited",
      });
      await expect(client.chat([{ role: "user", content: "Hi" }])).rejects.toThrow(
        "Chat API error: 429",
      );
    });

    it("should pass temperature and response_format", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: '{"a":1}' } }],
        }),
      });
      await client.chat([{ role: "user", content: "Hi" }], {
        temperature: 0,
        responseFormat: { type: "json_object" },
      });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.temperature).toBe(0);
      expect(body.response_format).toEqual({ type: "json_object" });
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run packages/server/test/llm/client.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 chat 客户端**

创建 `packages/server/src/llm/client.ts`，遵循 embedding client 的工厂模式：

```typescript
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  responseFormat?: { type: "json_object" | "text" };
}

export interface ChatResponse {
  role: "assistant";
  content: string;
}

export interface ChatClientConfig {
  apiBase: string;
  apiKey: string;
  model: string;
}

export interface ChatClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
  chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
}

export function createChatClient(config: ChatClientConfig): ChatClient {
  const { apiBase, apiKey, model } = config;

  async function chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.responseFormat) body.response_format = options.responseFormat;

    const response = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Chat API error: ${response.status} ${response.statusText} - ${text}`);
    }

    const data = (await response.json()) as {
      choices: { message: { role: string; content: string } }[];
    };
    return {
      role: "assistant",
      content: data.choices[0].message.content,
    };
  }

  async function* chatStream(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncIterable<string> {
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
    };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.responseFormat) body.response_format = options.responseFormat;

    const response = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Chat API error: ${response.status} ${response.statusText} - ${text}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") return;
        const chunk = JSON.parse(payload) as {
          choices: { delta: { content?: string } }[];
        };
        const content = chunk.choices[0]?.delta?.content;
        if (content) yield content;
      }
    }
  }

  return { chat, chatStream };
}
```

- [ ] **Step 4: 运行 chat 测试验证通过**

Run: `npx vitest run packages/server/test/llm/client.test.ts`
Expected: ALL PASS (3 tests)

- [ ] **Step 5: 追加 chatStream 测试**

在测试文件的 `describe("ChatClient")` 中追加：

```typescript
describe("chatStream", () => {
  it("should yield tokens from SSE stream", async () => {
    const sseData = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseData));
        controller.close();
      },
    });
    mockFetch.mockResolvedValueOnce({ ok: true, body: stream });
    const tokens: string[] = [];
    for await (const token of client.chatStream([{ role: "user", content: "Hi" }])) {
      tokens.push(token);
    }
    expect(tokens).toEqual(["Hello", " world"]);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.stream).toBe(true);
  });
});
```

- [ ] **Step 6: 运行全部 LLM 客户端测试**

Run: `npx vitest run packages/server/test/llm/client.test.ts`
Expected: ALL PASS (4 tests)

- [ ] **Step 7: 全量测试确认无回归**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/llm/ packages/server/test/llm/
git commit -m "feat(server): add OpenAI-compatible chat completion client"
```

---

## Chunk 2: Interview 核心模块（Prompts + Extractor + Recall + Contradiction）

### Task 4: Prompt 模板

**Files:**

- Create: `packages/server/src/interview/prompts.ts`

- [ ] **Step 1: 创建 prompts.ts（纯函数，无副作用）**

```typescript
import type { SoulAnchor } from "../types.js";

/** Step 1: 从用户回答中提取灵魂锚点 */
export function buildExtractionPrompt(
  userMessage: string,
  recentMessages: { role: string; content: string }[],
  existingAnchors: SoulAnchor[],
): { role: string; content: string }[] {
  const existingList = existingAnchors
    .map((a) => `Q: ${a.question}\nA: ${a.answer ?? "(未回答)"}`)
    .join("\n\n");

  return [
    {
      role: "system",
      content: `你是一个认知分析专家。分析用户的回答，提取灵魂锚点（核心问题与答案对）。

规则：
1. 每个锚点包含一个 question（锚定问题）和 answer（用户的回答）
2. question 应该是通用的、可复用的认知问题，不是对话中的原始提问
3. 不要重复提取已有锚点中已覆盖的内容
4. 如果没有新的可提取内容，返回空数组
5. 返回 JSON 数组格式

已有锚点：
${existingList || "(暂无)"}

输出格式：{"anchors": [{"question": "...", "answer": "..."}]}`,
    },
    ...recentMessages.slice(-4),
    { role: "user", content: userMessage },
  ];
}

/** Step 2: Agentic Recall 充分性判断 */
export function buildRecallJudgmentPrompt(
  recalledAnchors: SoulAnchor[],
  context: string,
  goal: string,
): { role: string; content: string }[] {
  const anchorList = recalledAnchors
    .map((a) => `Q: ${a.question}\nA: ${a.answer ?? "(未回答)"}`)
    .join("\n\n");

  return [
    {
      role: "system",
      content: `你是一个认知充分性评估专家。判断当前召回的锚点是否足以完成目标。

当前目标：${goal}

已召回锚点：
${anchorList || "(暂无)"}

对话上下文：
${context}

判断规则：
1. 如果锚点足以支撑目标，返回 sufficient: true
2. 如果不够，返回 sufficient: false 并给出新的检索 query
3. 同时输出一段面向用户的思考叙述（narrative），展示你的思考过程

输出 JSON：{"sufficient": boolean, "nextQuery": "...", "reason": "...", "narrative": "..."}`,
    },
  ];
}

/** Step 3: 矛盾检测 */
export function buildContradictionPrompt(
  newAnchors: { question: string; answer: string }[],
  existingAnchors: SoulAnchor[],
): { role: string; content: string }[] {
  return [
    {
      role: "system",
      content: `你是一个逻辑一致性检测专家。比较新提取的锚点与已有锚点，找出矛盾。

新提取锚点：
${JSON.stringify(newAnchors, null, 2)}

已有锚点：
${existingAnchors.map((a) => `Q: ${a.question}\nA: ${a.answer ?? "(未回答)"}`).join("\n\n")}

规则：
1. 只标记真正矛盾的内容，观点演变不算矛盾
2. 如果没有矛盾，返回空数组

输出 JSON：{"contradictions": [{"newAnchor": "...", "existingAnchor": "...", "description": "..."}]}`,
    },
  ];
}

/** Step 4: 访谈主持人系统 prompt */
export function buildInterviewerSystemPrompt(
  recalledAnchors: SoulAnchor[],
  contradictions: { newAnchor: string; existingAnchor: string; description: string }[],
  totalAnchors: number,
): string {
  const anchorSummary = recalledAnchors
    .map((a) => `- ${a.question}: ${a.answer ?? "(未回答)"}`)
    .join("\n");

  const contradictionNote =
    contradictions.length > 0
      ? `\n\n## 发现的矛盾（优先追问）\n${contradictions.map((c) => `- ${c.description}`).join("\n")}`
      : "";

  return `你是 ReMi 的 AI 访谈主持人。你的使命是通过结构化访谈，深度挖掘本体的隐含知识。

## 已知灵魂锚点（${totalAnchors} 个）
${anchorSummary || "(暂无，这是第一次对话)"}
${contradictionNote}

## 访谈协议
1. **三步提问**：先轻量 → 再求新 → 最后具体
2. **状态感知**：识别受访者状态（愿意聊/防御/疲劳/跑题），调整风格
3. **不问已知**：已有锚点覆盖的内容不重复追问
4. **始终探索**：每次回复必须包含一个新问题

## 输出要求
先自然地回应用户的上一条消息，然后提出新问题。保持对话流畅自然。`;
}
```

- [ ] **Step 2: 验证编译**

Run: `npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: 无新增错误

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/interview/prompts.ts
git commit -m "feat(server): add interview prompt templates"
```

---

### Task 5: 锚点提取器 (extractor.ts)

**Files:**

- Create: `packages/server/src/interview/extractor.ts`
- Create: `packages/server/test/interview/extractor.test.ts`

- [ ] **Step 1: 写提取器测试**

```typescript
import { describe, it, expect, vi } from "vitest";
import { extractAnchors } from "../../src/interview/extractor.js";
import type { ChatClient } from "../../src/llm/client.js";
import type { SoulAnchor } from "../../src/types.js";

function mockChatClient(response: string): ChatClient {
  return {
    chat: vi.fn().mockResolvedValue({ role: "assistant", content: response }),
    chatStream: vi.fn(),
  };
}

describe("extractAnchors", () => {
  it("should extract anchors from LLM response", async () => {
    const client = mockChatClient(
      JSON.stringify({ anchors: [{ question: "你最看重什么价值观？", answer: "诚实和透明" }] }),
    );
    const result = await extractAnchors({
      chatClient: client,
      userMessage: "我觉得做人最重要的是诚实",
      recentMessages: [],
      existingAnchors: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0].question).toBe("你最看重什么价值观？");
    expect(result[0].answer).toBe("诚实和透明");
    expect(client.chat).toHaveBeenCalledTimes(1);
  });

  it("should return empty array on invalid JSON", async () => {
    const client = mockChatClient("这不是有效的 JSON");
    const result = await extractAnchors({
      chatClient: client,
      userMessage: "随便说点什么",
      recentMessages: [],
      existingAnchors: [],
    });
    expect(result).toEqual([]);
  });

  it("should return empty array on LLM error", async () => {
    const client: ChatClient = {
      chat: vi.fn().mockRejectedValue(new Error("LLM down")),
      chatStream: vi.fn(),
    };
    const result = await extractAnchors({
      chatClient: client,
      userMessage: "test",
      recentMessages: [],
      existingAnchors: [],
    });
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run packages/server/test/interview/extractor.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现提取器**

```typescript
import type { ChatClient } from "../llm/client.js";
import type { SoulAnchor } from "../types.js";
import { buildExtractionPrompt } from "./prompts.js";

export interface ExtractOptions {
  chatClient: ChatClient;
  userMessage: string;
  recentMessages: { role: string; content: string }[];
  existingAnchors: SoulAnchor[];
}

export async function extractAnchors(
  options: ExtractOptions,
): Promise<{ question: string; answer: string }[]> {
  try {
    const messages = buildExtractionPrompt(
      options.userMessage,
      options.recentMessages,
      options.existingAnchors,
    );
    const response = await options.chatClient.chat(
      messages as { role: "system" | "user" | "assistant"; content: string }[],
      { temperature: 0, responseFormat: { type: "json_object" } },
    );
    const parsed = JSON.parse(response.content);
    const anchors = parsed.anchors ?? parsed;
    if (Array.isArray(anchors)) {
      return anchors.filter(
        (item: unknown) =>
          typeof item === "object" && item !== null && "question" in item && "answer" in item,
      );
    }
    return [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run packages/server/test/interview/extractor.test.ts`
Expected: ALL PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/interview/extractor.ts \
  packages/server/test/interview/extractor.test.ts
git commit -m "feat(server): add soul anchor extractor"
```

---

### Task 6: Agentic Recall (recall.ts)

**Files:**

- Create: `packages/server/src/interview/recall.ts`
- Create: `packages/server/test/interview/recall.test.ts`

- [ ] **Step 1: 写 Recall 测试**

```typescript
import { describe, it, expect, vi } from "vitest";
import { agenticRecall } from "../../src/interview/recall.js";
import type { ChatClient } from "../../src/llm/client.js";
import type { SoulAnchor } from "../../src/types.js";

function mockChatClient(responses: string[]): ChatClient {
  const chatFn = vi.fn();
  for (const r of responses) {
    chatFn.mockResolvedValueOnce({ role: "assistant", content: r });
  }
  return { chat: chatFn, chatStream: vi.fn() };
}

function mockEmbeddingClient(embeddings: number[][]) {
  return { embed: vi.fn().mockResolvedValue(embeddings) };
}

describe("agenticRecall", () => {
  it("should return immediately if sufficient on first round", async () => {
    const client = mockChatClient([
      JSON.stringify({
        sufficient: true,
        reason: "enough",
        narrative: "我已经了解够了",
      }),
    ]);
    const narratives: string[] = [];
    const result = await agenticRecall({
      chatClient: client,
      embeddingClient: mockEmbeddingClient([[0.1, 0.2]]),
      searchAnchors: async () => [],
      context: "test context",
      goal: "test goal",
      maxRounds: 5,
      topK: 10,
      onNarrative: (n) => narratives.push(n),
    });
    expect(result.sufficient).toBe(true);
    expect(result.rounds).toBe(1);
    expect(narratives).toEqual(["我已经了解够了"]);
  });

  it("should loop until sufficient", async () => {
    const anchor: SoulAnchor = {
      id: "1",
      question: "价值观",
      answer: "诚实",
      source: "interview",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const client = mockChatClient([
      JSON.stringify({
        sufficient: false,
        nextQuery: "价值观",
        reason: "need more",
        narrative: "让我再想想...",
      }),
      JSON.stringify({
        sufficient: true,
        reason: "ok now",
        narrative: "现在够了",
      }),
    ]);
    const result = await agenticRecall({
      chatClient: client,
      embeddingClient: mockEmbeddingClient([
        [0.1, 0.2],
        [0.3, 0.4],
      ]),
      searchAnchors: async () => [anchor],
      context: "test",
      goal: "test",
      maxRounds: 5,
      topK: 10,
    });
    expect(result.sufficient).toBe(true);
    expect(result.rounds).toBe(2);
    expect(result.anchors).toContainEqual(anchor);
  });

  it("should stop at maxRounds", async () => {
    const client = mockChatClient([
      JSON.stringify({ sufficient: false, nextQuery: "q1", reason: "r", narrative: "n1" }),
      JSON.stringify({ sufficient: false, nextQuery: "q2", reason: "r", narrative: "n2" }),
      JSON.stringify({ sufficient: false, nextQuery: "q3", reason: "r", narrative: "n3" }),
    ]);
    const result = await agenticRecall({
      chatClient: client,
      embeddingClient: mockEmbeddingClient([[0.1], [0.2], [0.3]]),
      searchAnchors: async () => [],
      context: "test",
      goal: "test",
      maxRounds: 3,
      topK: 10,
    });
    expect(result.sufficient).toBe(false);
    expect(result.rounds).toBe(3);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run packages/server/test/interview/recall.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 Agentic Recall**

```typescript
import type { ChatClient } from "../llm/client.js";
import type { SoulAnchor } from "../types.js";
import type { EmbeddingClient } from "../embedding/client.js";
import { buildRecallJudgmentPrompt } from "./prompts.js";

export interface RecallOptions {
  chatClient: ChatClient;
  embeddingClient: EmbeddingClient;
  searchAnchors: (embedding: number[]) => Promise<SoulAnchor[]>;
  context: string;
  goal: string;
  maxRounds?: number;
  topK?: number;
  onNarrative?: (text: string) => void;
}

export interface RecallResult {
  anchors: SoulAnchor[];
  narratives: string[];
  rounds: number;
  sufficient: boolean;
}

export async function agenticRecall(options: RecallOptions): Promise<RecallResult> {
  const {
    chatClient,
    embeddingClient,
    searchAnchors,
    context,
    goal,
    maxRounds = 5,
    onNarrative,
  } = options;

  const allAnchors = new Map<string, SoulAnchor>();
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

    // LLM 判断充分性
    const messages = buildRecallJudgmentPrompt(Array.from(allAnchors.values()), context, goal);
    const response = await chatClient.chat(
      messages as { role: "system" | "user" | "assistant"; content: string }[],
      { temperature: 0, responseFormat: { type: "json_object" } },
    );

    let judgment: {
      sufficient: boolean;
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

Run: `npx vitest run packages/server/test/interview/recall.test.ts`
Expected: ALL PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/interview/recall.ts \
  packages/server/test/interview/recall.test.ts
git commit -m "feat(server): add agentic recall loop"
```

---

### Task 7: 矛盾检测 (contradiction.ts)

**Files:**

- Create: `packages/server/src/interview/contradiction.ts`
- Create: `packages/server/test/interview/contradiction.test.ts`

- [ ] **Step 1: 写矛盾检测测试**

```typescript
import { describe, it, expect, vi } from "vitest";
import { detectContradictions } from "../../src/interview/contradiction.js";
import type { ChatClient } from "../../src/llm/client.js";

function mockChatClient(response: string): ChatClient {
  return {
    chat: vi.fn().mockResolvedValue({ role: "assistant", content: response }),
    chatStream: vi.fn(),
  };
}

describe("detectContradictions", () => {
  it("should return contradictions from LLM", async () => {
    const client = mockChatClient(
      JSON.stringify({
        contradictions: [
          {
            newAnchor: "我喜欢独处",
            existingAnchor: "我是外向的人",
            description: "独处偏好与外向性格矛盾",
          },
        ],
      }),
    );
    const result = await detectContradictions({
      chatClient: client,
      newAnchors: [{ question: "你喜欢独处吗？", answer: "是的" }],
      existingAnchors: [
        {
          id: "1",
          question: "你的性格？",
          answer: "外向",
          source: "interview",
          created_at: 0,
          updated_at: 0,
        },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].description).toContain("矛盾");
  });

  it("should return empty on no contradictions", async () => {
    const client = mockChatClient(JSON.stringify({ contradictions: [] }));
    const result = await detectContradictions({
      chatClient: client,
      newAnchors: [{ question: "q", answer: "a" }],
      existingAnchors: [],
    });
    expect(result).toEqual([]);
  });

  it("should return empty on LLM error", async () => {
    const client: ChatClient = {
      chat: vi.fn().mockRejectedValue(new Error("fail")),
      chatStream: vi.fn(),
    };
    const result = await detectContradictions({
      chatClient: client,
      newAnchors: [{ question: "q", answer: "a" }],
      existingAnchors: [],
    });
    expect(result).toEqual([]);
  });

  it("should skip if no new anchors", async () => {
    const client = mockChatClient("{}");
    const result = await detectContradictions({
      chatClient: client,
      newAnchors: [],
      existingAnchors: [],
    });
    expect(result).toEqual([]);
    expect(client.chat).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run packages/server/test/interview/contradiction.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现矛盾检测**

```typescript
import type { ChatClient } from "../llm/client.js";
import type { SoulAnchor } from "../types.js";
import { buildContradictionPrompt } from "./prompts.js";

export interface Contradiction {
  newAnchor: string;
  existingAnchor: string;
  description: string;
}

export interface ContradictionOptions {
  chatClient: ChatClient;
  newAnchors: { question: string; answer: string }[];
  existingAnchors: SoulAnchor[];
}

export async function detectContradictions(
  options: ContradictionOptions,
): Promise<Contradiction[]> {
  if (options.newAnchors.length === 0) return [];

  try {
    const messages = buildContradictionPrompt(options.newAnchors, options.existingAnchors);
    const response = await options.chatClient.chat(
      messages as { role: "system" | "user" | "assistant"; content: string }[],
      { temperature: 0, responseFormat: { type: "json_object" } },
    );
    const parsed = JSON.parse(response.content);
    if (parsed.contradictions && Array.isArray(parsed.contradictions)) {
      return parsed.contradictions;
    }
    return [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run packages/server/test/interview/contradiction.test.ts`
Expected: ALL PASS (4 tests)

- [ ] **Step 5: 全量测试确认无回归**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/interview/contradiction.ts \
  packages/server/test/interview/contradiction.test.ts
git commit -m "feat(server): add contradiction detection"
```

---

## Chunk 3: 引擎编排 + API 路由 + 应用集成

### Task 8: Interview Engine 主循环 (engine.ts)

**Files:**

- Create: `packages/server/src/interview/engine.ts`
- Create: `packages/server/test/interview/engine.test.ts`

- [ ] **Step 1: 写 engine 编排测试**

```typescript
import { describe, it, expect, vi } from "vitest";
import { InterviewEngine } from "../../src/interview/engine.js";
import type { ChatClient } from "../../src/llm/client.js";
import type { SoulAnchor } from "../../src/types.js";

function createMockDeps() {
  const chatClient: ChatClient = {
    chat: vi.fn().mockResolvedValue({
      role: "assistant",
      content: JSON.stringify({ sufficient: true, reason: "ok", narrative: "thinking..." }),
    }),
    chatStream: vi.fn().mockReturnValue(
      (async function* () {
        yield "回复";
        yield "内容";
      })(),
    ),
  };
  const embeddingClient = {
    embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
  };
  return { chatClient, embeddingClient };
}

describe("InterviewEngine", () => {
  it("should run start flow (cold start)", async () => {
    const { chatClient, embeddingClient } = createMockDeps();
    const engine = new InterviewEngine({
      chatClient,
      embeddingClient,
      getMessages: async () => [],
      saveMessage: vi.fn(),
      getAnchors: async () => [],
      saveAnchors: vi.fn(),
      searchAnchors: async () => [],
      getAnchorCount: async () => 0,
    });

    const events: { type: string; data: unknown }[] = [];
    await engine.start({
      emitThinking: (n) => events.push({ type: "thinking", data: n }),
      emitToken: (c) => events.push({ type: "token", data: c }),
      emitDone: (d) => events.push({ type: "done", data: d }),
      emitError: (code, msg) => events.push({ type: "error", data: { code, msg } }),
    });

    expect(events.some((e) => e.type === "token")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("should run message flow with extraction", async () => {
    const { chatClient, embeddingClient } = createMockDeps();
    // 第一次 chat 调用: extraction
    (chatClient.chat as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        role: "assistant",
        content: JSON.stringify([{ question: "价值观", answer: "诚实" }]),
      })
      // 第二次: recall judgment
      .mockResolvedValueOnce({
        role: "assistant",
        content: JSON.stringify({ sufficient: true, reason: "ok", narrative: "想好了" }),
      })
      // 第三次: contradiction (empty)
      .mockResolvedValueOnce({
        role: "assistant",
        content: JSON.stringify({ contradictions: [] }),
      });

    const savedAnchors: unknown[] = [];
    const engine = new InterviewEngine({
      chatClient,
      embeddingClient,
      getMessages: async () => [
        { id: 1, role: "assistant" as const, content: "你好", created_at: Date.now() },
      ],
      saveMessage: vi.fn(),
      getAnchors: async () => [],
      saveAnchors: vi.fn().mockImplementation((a) => savedAnchors.push(...a)),
      searchAnchors: async () => [],
      getAnchorCount: async () => 0,
    });

    const events: { type: string; data: unknown }[] = [];
    await engine.handleMessage("我觉得诚实很重要", {
      emitThinking: (n) => events.push({ type: "thinking", data: n }),
      emitToken: (c) => events.push({ type: "token", data: c }),
      emitDone: (d) => events.push({ type: "done", data: d }),
      emitError: () => {},
    });

    expect(savedAnchors.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === "thinking")).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run packages/server/test/interview/engine.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 InterviewEngine**

```typescript
import type { ChatClient, ChatMessage } from "../llm/client.js";
import type { EmbeddingClient } from "../embedding/client.js";
import type { SoulAnchor } from "../types.js";
import { extractAnchors } from "./extractor.js";
import { agenticRecall } from "./recall.js";
import { detectContradictions } from "./contradiction.js";
import { buildInterviewerSystemPrompt } from "./prompts.js";

export interface SSEEmitter {
  emitThinking(narrative: string): void;
  emitToken(content: string): void;
  emitDone(data: { messageId: number; anchorsExtracted: number }): void;
  emitError(code: string, message: string): void;
}

export interface EngineDeps {
  chatClient: ChatClient;
  embeddingClient: EmbeddingClient;
  getMessages(
    limit: number,
  ): Promise<
    { id: number; role: "user" | "assistant" | "system"; content: string; created_at: number }[]
  >;
  saveMessage(role: "user" | "assistant", content: string): Promise<number>;
  getAnchors(limit: number): Promise<SoulAnchor[]>;
  saveAnchors(anchors: { question: string; answer: string }[]): Promise<void>;
  searchAnchors(embedding: number[]): Promise<SoulAnchor[]>;
  getAnchorCount(): Promise<number>;
}

const WINDOW_SIZE = 20;

export class InterviewEngine {
  constructor(private deps: EngineDeps) {}

  async start(emitter: SSEEmitter): Promise<void> {
    try {
      const messages = await this.deps.getMessages(WINDOW_SIZE);
      const anchors = await this.deps.getAnchors(100);
      const anchorCount = await this.deps.getAnchorCount();

      // Agentic Recall
      const recall = await agenticRecall({
        chatClient: this.deps.chatClient,
        embeddingClient: this.deps.embeddingClient,
        searchAnchors: (emb) => this.deps.searchAnchors(emb),
        context:
          messages
            .map((m) => `${m.role}: ${m.content}`)
            .join("\n")
            .slice(-2000) || "新用户，第一次对话",
        goal: "理解本体已有的认知框架，准备发起/恢复访谈",
        onNarrative: (n) => emitter.emitThinking(n),
      });

      // 生成回复
      const systemPrompt = buildInterviewerSystemPrompt(recall.anchors, [], anchorCount);
      const chatMessages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ];

      if (messages.length === 0) {
        chatMessages.push({
          role: "system",
          content: "这是第一次对话，请用冷启动协议开场：声明边界，给选择权，用轻量级问题。",
        });
      } else {
        chatMessages.push({
          role: "system",
          content: "用户回来继续对话，生成一条恢复衔接消息。",
        });
      }

      let fullContent = "";
      for await (const token of this.deps.chatClient.chatStream(chatMessages)) {
        fullContent += token;
        emitter.emitToken(token);
      }

      const messageId = await this.deps.saveMessage("assistant", fullContent);
      emitter.emitDone({ messageId, anchorsExtracted: 0 });
    } catch (error) {
      emitter.emitError("LLM_ERROR", error instanceof Error ? error.message : "Unknown error");
    }
  }

  async handleMessage(content: string, emitter: SSEEmitter): Promise<void> {
    try {
      // 保存用户消息
      await this.deps.saveMessage("user", content);
      const messages = await this.deps.getMessages(WINDOW_SIZE);
      const existingAnchors = await this.deps.getAnchors(200);

      // Step 1: 锚点提取
      const newAnchors = await extractAnchors({
        chatClient: this.deps.chatClient,
        userMessage: content,
        recentMessages: messages.slice(-6).map((m) => ({ role: m.role, content: m.content })),
        existingAnchors,
      });

      if (newAnchors.length > 0) {
        await this.deps.saveAnchors(newAnchors);
      }

      // Step 2: Agentic Recall
      const recall = await agenticRecall({
        chatClient: this.deps.chatClient,
        embeddingClient: this.deps.embeddingClient,
        searchAnchors: (emb) => this.deps.searchAnchors(emb),
        context: messages
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n")
          .slice(-2000),
        goal: "充分理解本体在当前话题的认知，问出好问题",
        onNarrative: (n) => emitter.emitThinking(n),
      });

      // Step 3: 矛盾检测
      const contradictions = await detectContradictions({
        chatClient: this.deps.chatClient,
        newAnchors,
        existingAnchors: recall.anchors,
      });

      // Step 4: 生成回复
      const anchorCount = await this.deps.getAnchorCount();
      const systemPrompt = buildInterviewerSystemPrompt(
        recall.anchors,
        contradictions,
        anchorCount,
      );
      const chatMessages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ];

      let fullContent = "";
      for await (const token of this.deps.chatClient.chatStream(chatMessages)) {
        fullContent += token;
        emitter.emitToken(token);
      }

      const messageId = await this.deps.saveMessage("assistant", fullContent);
      emitter.emitDone({ messageId, anchorsExtracted: newAnchors.length });
    } catch (error) {
      emitter.emitError("LLM_ERROR", error instanceof Error ? error.message : "Unknown error");
    }
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run packages/server/test/interview/engine.test.ts`
Expected: ALL PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/interview/engine.ts \
  packages/server/test/interview/engine.test.ts
git commit -m "feat(server): add interview engine orchestrator"
```

---

### Task 9: Interview API 路由 (routes/interview.ts)

**Files:**

- Create: `packages/server/src/routes/interview.ts`
- Create: `packages/server/test/routes/interview.test.ts`

- [ ] **Step 1: 写路由测试**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { interviewRoutes } from "../../src/routes/interview.js";
import { ConnectionManager } from "../../src/db/connection.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PUB_KEY = "testPubKey123";

function createTestApp(
  connMgr: ConnectionManager,
  pubKey: string,
  chatClient: any,
  embeddingClient: any,
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("signerPubKey", pubKey);
    c.set("role", pubKey === c.req.param("pubKey") ? "owner" : "visitor");
    c.set("connMgr", connMgr);
    c.set("chatClient", chatClient);
    c.set("embeddingClient", embeddingClient);
    await next();
  });
  app.route("/api", interviewRoutes);
  return app;
}

describe("interview routes", () => {
  let tmpDir: string;
  let connMgr: ConnectionManager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `remi-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    connMgr = new ConnectionManager(tmpDir, {
      maxSize: 10,
      embeddingDimensions: 4,
    });
    connMgr.getConnection(PUB_KEY, { create: true });
  });

  afterEach(() => {
    connMgr.closeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /interview/status should return stats", async () => {
    const app = createTestApp(connMgr, PUB_KEY, null, null);
    const res = await app.request(`/api/${PUB_KEY}/interview/status`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveProperty("totalAnchors");
    expect(json.data).toHaveProperty("totalMessages");
  });

  it("GET /interview/messages should return empty list", async () => {
    const app = createTestApp(connMgr, PUB_KEY, null, null);
    const res = await app.request(`/api/${PUB_KEY}/interview/messages?limit=20`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.items).toEqual([]);
    expect(json.data.hasMore).toBe(false);
  });

  it("should reject visitor", async () => {
    const app = createTestApp(connMgr, "otherKey", null, null);
    const res = await app.request(`/api/${PUB_KEY}/interview/status`);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run packages/server/test/routes/interview.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现路由**

```typescript
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, sql, desc } from "drizzle-orm";
import { messages as messagesTable, soulAnchors } from "../db/schema.js";
import { InterviewEngine } from "../interview/engine.js";
import type { SSEEmitter } from "../interview/engine.js";
import type { ConnectionManager } from "../db/connection.js";
import type { ChatClient } from "../llm/client.js";
import type { EmbeddingClient } from "../embedding/client.js";
import { searchSimilar, upsertEmbedding } from "../embedding/index.js";

const messageSchema = z.object({ content: z.string().min(1) });

function requireOwner(c: any) {
  if (c.get("role") !== "owner") {
    return c.json({ error: "FORBIDDEN", message: "Owner only" }, 403);
  }
  return null;
}

export const interviewRoutes = new Hono();

// GET /:pubKey/interview/status
interviewRoutes.get("/:pubKey/interview/status", async (c) => {
  const forbidden = requireOwner(c);
  if (forbidden) return forbidden;

  const connMgr = c.get("connMgr") as ConnectionManager;
  const pubKey = c.req.param("pubKey");
  const { drizzle } = connMgr.getConnection(pubKey);

  const [anchorCount] = drizzle
    .select({ count: sql<number>`count(*)` })
    .from(soulAnchors)
    .all();
  const [messageCount] = drizzle
    .select({ count: sql<number>`count(*)` })
    .from(messagesTable)
    .all();
  const lastMessage = drizzle
    .select({ created_at: messagesTable.createdAt })
    .from(messagesTable)
    .orderBy(desc(messagesTable.id))
    .limit(1)
    .all();

  return c.json({
    data: {
      totalAnchors: anchorCount.count,
      totalMessages: messageCount.count,
      lastActiveAt: lastMessage[0]?.created_at ?? null,
    },
  });
});

// GET /:pubKey/interview/messages
interviewRoutes.get("/:pubKey/interview/messages", async (c) => {
  const forbidden = requireOwner(c);
  if (forbidden) return forbidden;

  const connMgr = c.get("connMgr") as ConnectionManager;
  const pubKey = c.req.param("pubKey");
  const { drizzle } = connMgr.getConnection(pubKey);

  const limit = Math.min(parseInt(c.req.query("limit") ?? "20"), 100);
  const before = c.req.query("before") ? parseInt(c.req.query("before")!) : undefined;

  let query = drizzle
    .select()
    .from(messagesTable)
    .orderBy(desc(messagesTable.id))
    .limit(limit + 1);

  if (before !== undefined) {
    query = query.where(sql`${messagesTable.id} < ${before}`) as typeof query;
  }

  const rows = query.all();
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);

  return c.json({ data: { items, hasMore } });
});

// POST /:pubKey/interview/start
interviewRoutes.post("/:pubKey/interview/start", async (c) => {
  const forbidden = requireOwner(c);
  if (forbidden) return forbidden;

  const chatClient = c.get("chatClient") as ChatClient | null;
  const embeddingClient = c.get("embeddingClient") as EmbeddingClient | null;
  if (!chatClient || !embeddingClient) {
    return c.json({ error: "LLM_ERROR", message: "LLM not configured" }, 500);
  }

  const connMgr = c.get("connMgr") as ConnectionManager;
  const pubKey = c.req.param("pubKey");
  const { drizzle, raw } = connMgr.getConnection(pubKey);

  const engine = createEngine(drizzle, raw, chatClient, embeddingClient);

  return streamSSE(c, async (stream) => {
    const emitter = createSSEEmitter(stream);
    await engine.start(emitter);
  });
});

// POST /:pubKey/interview/message
interviewRoutes.post(
  "/:pubKey/interview/message",
  zValidator("json", messageSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "VALIDATION_ERROR", message: "content is required" }, 422);
    }
  }),
  async (c) => {
    const forbidden = requireOwner(c);
    if (forbidden) return forbidden;

    const chatClient = c.get("chatClient") as ChatClient | null;
    const embeddingClient = c.get("embeddingClient") as EmbeddingClient | null;
    if (!chatClient || !embeddingClient) {
      return c.json({ error: "LLM_ERROR", message: "LLM not configured" }, 500);
    }

    const { content } = c.req.valid("json");
    const connMgr = c.get("connMgr") as ConnectionManager;
    const pubKey = c.req.param("pubKey");
    const { drizzle, raw } = connMgr.getConnection(pubKey);

    const engine = createEngine(drizzle, raw, chatClient, embeddingClient);

    return streamSSE(c, async (stream) => {
      const emitter = createSSEEmitter(stream);
      await engine.handleMessage(content, emitter);
    });
  },
);

function createEngine(
  drizzle: any,
  raw: any,
  chatClient: ChatClient,
  embeddingClient: EmbeddingClient,
) {
  return new InterviewEngine({
    chatClient,
    embeddingClient,
    getMessages: async (limit) =>
      drizzle
        .select()
        .from(messagesTable)
        .orderBy(desc(messagesTable.id))
        .limit(limit)
        .all()
        .reverse(),
    saveMessage: async (role, content) => {
      const result = drizzle
        .insert(messagesTable)
        .values({
          role,
          content,
          createdAt: Date.now(),
        })
        .returning({ id: messagesTable.id })
        .get();
      return result.id;
    },
    getAnchors: async (limit) => drizzle.select().from(soulAnchors).limit(limit).all(),
    saveAnchors: async (anchors) => {
      for (const a of anchors) {
        const id = crypto.randomUUID();
        drizzle
          .insert(soulAnchors)
          .values({
            id,
            question: a.question,
            answer: a.answer,
            source: "interview",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
          .run();
        // 异步 embedding
        const text = `${a.question}\n${a.answer}`;
        embeddingClient
          .embed([text])
          .then(([emb]) => {
            upsertEmbedding(raw, "soul_anchors_vec", id, emb);
          })
          .catch((e) => console.error("embedding error:", e));
      }
    },
    searchAnchors: async (embedding) => {
      const results = searchSimilar(raw, "soul_anchors_vec", embedding, 10);
      if (results.length === 0) return [];
      const ids = results.map((r) => r.id);
      return drizzle
        .select()
        .from(soulAnchors)
        .where(
          sql`${soulAnchors.id} IN (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        )
        .all();
    },
    getAnchorCount: async () => {
      const [row] = drizzle
        .select({ count: sql<number>`count(*)` })
        .from(soulAnchors)
        .all();
      return row.count;
    },
  });
}

function createSSEEmitter(stream: any): SSEEmitter {
  return {
    emitThinking: (narrative) =>
      stream.writeSSE({ event: "thinking", data: JSON.stringify({ narrative }) }),
    emitToken: (content) => stream.writeSSE({ event: "token", data: JSON.stringify({ content }) }),
    emitDone: (data) => stream.writeSSE({ event: "done", data: JSON.stringify(data) }),
    emitError: (code, message) =>
      stream.writeSSE({ event: "error", data: JSON.stringify({ code, message }) }),
  };
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run packages/server/test/routes/interview.test.ts`
Expected: ALL PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/interview.ts \
  packages/server/test/routes/interview.test.ts
git commit -m "feat(server): add interview API routes with SSE"
```

---

### Task 10: 应用集成（app.ts + index.ts）

**Files:**

- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: 在 app.ts 中挂载 interview 路由和注入 chatClient**

在 `app.ts` 中：

1. 导入 `interviewRoutes` 和 `ChatClient` 类型
2. 在 `AppConfig` 接口中添加 `chatClient?` 可选字段（类型 `ChatClient`）
3. 在 `ContextVariableMap`（当前声明在 `anchors.ts`）中添加 `chatClient: ChatClient | null`
4. 在 context 注入中间件中添加 `c.set("chatClient", config.chatClient ?? null)`
5. 挂载路由：`app.route("/api", interviewRoutes)`（在已有路由之后）

**注意：** `ContextVariableMap` 声明在 `anchors.ts` 中，需要在那里或 `app.ts` 中追加 `chatClient` 声明，确保 Hono 类型安全。

- [ ] **Step 2: 在 index.ts 中读取 LLM 环境变量**

在 `index.ts` 中：

1. 导入 `createChatClient`
2. 读取环境变量 `LLM_API_BASE`、`LLM_API_KEY`、`LLM_MODEL`
3. 如果三个变量都存在，创建 chatClient 并传入 `createApp()`

```typescript
const llmApiBase = process.env.LLM_API_BASE;
const llmApiKey = process.env.LLM_API_KEY;
const llmModel = process.env.LLM_MODEL;

const chatClient =
  llmApiBase && llmApiKey && llmModel
    ? createChatClient({ apiBase: llmApiBase, apiKey: llmApiKey, model: llmModel })
    : undefined;
```

- [ ] **Step 3: 验证编译**

Run: `npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: 无新增错误

- [ ] **Step 4: 全量测试确认无回归**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/app.ts packages/server/src/index.ts
git commit -m "feat(server): integrate interview engine into app"
```

---

### Task 11: 端到端集成测试

**Files:**

- Create: `test/interview-integration.test.ts`

- [ ] **Step 1: 写端到端测试**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp } from "@remi/server/app";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeyPair, sign, getPublicKey } from "@remi/crypto";
import { hashBody, buildStringToSign } from "@remi/crypto";
import { base58Encode } from "@remi/crypto";

// Mock LLM
const mockFetch = vi.fn();
const originalFetch = globalThis.fetch;

describe("interview integration", () => {
  let tmpDir: string;
  let privateKey: Uint8Array;
  let pubKey: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `remi-integ-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    privateKey = generateKeyPair();
    pubKey = base58Encode(await getPublicKey(privateKey));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("GET /interview/status should return initial stats", async () => {
    const { app } = createApp({ dataDir: tmpDir, embeddingDimensions: 4 });

    const timestamp = Date.now().toString();
    const bodyHash = hashBody("");
    const sts = buildStringToSign("GET", `/api/${pubKey}/interview/status`, timestamp, bodyHash);
    const signature = base58Encode(await sign(new TextEncoder().encode(sts), privateKey));

    const res = await app.request(`/api/${pubKey}/interview/status`, {
      headers: {
        "X-Public-Key": pubKey,
        "X-Timestamp": timestamp,
        "X-Signature": signature,
      },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.totalAnchors).toBe(0);
    expect(json.data.totalMessages).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试**

Run: `npx vitest run test/interview-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/interview-integration.test.ts
git commit -m "test: add interview engine integration test"
```

---

### Task 12: Lint + Format + 全量验证

- [ ] **Step 1: Lint 修复**

Run: `npm run lint:fix`
Expected: 无错误（或仅自动修复）

- [ ] **Step 2: Format**

Run: `npm run format`

- [ ] **Step 3: 全量测试**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "style: apply eslint and prettier to interview engine"
```
