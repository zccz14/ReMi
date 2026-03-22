# 推理冷启动召回策略实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让推理流程在少锚点冷启动阶段跳过 Batch Recall，直接全量注入全部锚点，同时保持中后期 Recall 路径、SSE 协议和审计字段结构稳定。

**Architecture:** 在 `reasoning` 域内引入命名阈值常量和双路径锚点选择逻辑。`ReasoningEngine` 先读取总锚点数，再选择 `full-injection` 或 `batch-recall` 路径；路由层补充锚点总数、全量锚点读取和 cache 来源过滤能力，并把 `embeddingClient` 依赖改成按路径延迟校验。为避免冷启动写入的全量 `recalled_anchors` 污染后续 Recall cache，需要给 assistant 消息增加内部策略标记，并把历史 `NULL` 标记消息视为 legacy Recall 来源继续兼容。

**Tech Stack:** TypeScript, Hono SSE, drizzle-orm, better-sqlite3, vitest

**Spec:** `docs/superpowers/specs/2026-03-22-reasoning-cold-start-design.md`

---

## 文件结构

```text
packages/server/src/
├── db/
│   ├── schema.ts                    # 修改：reasoning_messages 增加内部策略标记字段
│   └── migrate.ts                   # 修改：新增列 migration / 兼容已有库
├── reasoning/
│   ├── constants.ts                 # 新增：冷启动阈值常量与策略字面量
│   └── engine.ts                    # 修改：双路径锚点选择 + 分支延迟依赖校验 + 日志
├── routes/
│   └── reasoning.ts                 # 修改：新增 count/list/filter cache 能力，放宽入口 embedding 校验

packages/server/test/
├── db/
│   └── migrate.test.ts              # 修改：验证新字段存在
├── reasoning/
│   └── engine.test.ts               # 修改：覆盖冷启动/Recall 双路径及边界
└── routes/
    └── reasoning.test.ts            # 修改：验证 route 层冷启动不强依赖 embeddingClient、legacy cache 兼容、populated response 映射

test/
└── reasoning-integration.test.ts    # 修改：增加 fake client / seed helper / SSE 解析 helper，验证 done 结构稳定
```

---

## Chunk 1: 数据契约与常量

### Task 1: 为 assistant 消息增加锚点选择策略标记

**Files:**

- Modify: `packages/server/src/db/schema.ts`
- Modify: `packages/server/src/db/migrate.ts`
- Test: `packages/server/test/db/migrate.test.ts`

- [ ] **Step 1: 写失败测试，要求 `reasoning_messages` 包含策略字段**

在 `packages/server/test/db/migrate.test.ts` 的 `reasoning_messages` 表测试中追加断言：

```typescript
expect(columns).toEqual(
  expect.arrayContaining([
    "id",
    "visitor_key",
    "role",
    "content",
    "recalled_anchors",
    "anchor_selection_strategy",
    "created_at",
  ]),
);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/server/test/db/migrate.test.ts`
Expected: FAIL，提示 `anchor_selection_strategy` 列不存在

- [ ] **Step 3: 更新 Drizzle schema**

在 `packages/server/src/db/schema.ts` 的 `reasoningMessages` 表定义中新增列：

```typescript
anchorSelectionStrategy: text("anchor_selection_strategy", {
  enum: ["batch-recall", "full-injection"],
}),
```

保持 nullable，避免破坏既有历史消息读取。

- [ ] **Step 4: 更新 migration**

在 `packages/server/src/db/migrate.ts` 中：

1. 对新初始化数据库的 `CREATE TABLE reasoning_messages` 增加列：

```sql
anchor_selection_strategy TEXT CHECK(anchor_selection_strategy IN ('batch-recall', 'full-injection')),
```

2. 紧接着增加幂等补丁，为已有库补列；如果现有 migration 风格需要 `try/catch` 包裹重复列错误，就沿用该文件现有模式，不要自造新模式。

- [ ] **Step 5: 运行迁移测试确认通过**

Run: `npx vitest run packages/server/test/db/migrate.test.ts`
Expected: PASS

### Task 2: 提取推理冷启动常量

**Files:**

- Create: `packages/server/src/reasoning/constants.ts`
- Modify: `packages/server/src/reasoning/engine.ts`
- Test: `packages/server/test/reasoning/engine.test.ts`

- [ ] **Step 1: 写失败测试，要求边界值 `== threshold` 走冷启动**

在 `packages/server/test/reasoning/engine.test.ts` 里先写一个测试，构造 `countAnchors()` 返回阈值值，断言不调用 Recall 路径依赖（如 `getCachedAnchorIds` / `embeddingClient?.embed` / `chatClient.chat`）。

- [ ] **Step 2: 运行单测确认失败**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: FAIL，因为当前实现无阈值分支

- [ ] **Step 3: 创建常量模块**

创建 `packages/server/src/reasoning/constants.ts`：

```typescript
export const REASONING_FULL_INJECTION_THRESHOLD = 20;

export const REASONING_ANCHOR_SELECTION_STRATEGIES = {
  FULL_INJECTION: "full-injection",
  BATCH_RECALL: "batch-recall",
} as const;

export type ReasoningAnchorSelectionStrategy =
  (typeof REASONING_ANCHOR_SELECTION_STRATEGIES)[keyof typeof REASONING_ANCHOR_SELECTION_STRATEGIES];
```

- [ ] **Step 4: 仅接入常量导入，不改主逻辑**

在 `packages/server/src/reasoning/engine.ts` 里导入该常量，先让编译通过，为后续任务做准备。

- [ ] **Step 5: 运行目标单测确认仍失败但可编译**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: 仍有业务断言失败，但无 TS/import 错误

---

## Chunk 2: Engine 双路径

### Task 3: 扩展 ReasoningEngineDeps，为后续测试先补齐夹具

**Files:**

- Modify: `packages/server/src/reasoning/engine.ts`
- Test: `packages/server/test/reasoning/engine.test.ts`

- [ ] **Step 1: 扩展 deps 接口定义**

把 `ReasoningEngineDeps` 调整成：

```typescript
export interface ReasoningEngineDeps {
  chatClient: ChatClient;
  embeddingClient?: EmbeddingClient;
  countAnchors(): Promise<number>;
  listAnchors(limit?: number): Promise<SoulAnchor[]>;
  getMessages(...): Promise<...>;
  saveMessage(
    visitorKey: string,
    role: "user" | "assistant",
    content: string,
    recalledAnchors?: string[],
    anchorSelectionStrategy?: ReasoningAnchorSelectionStrategy,
  ): Promise<number>;
  searchAnchors(...): Promise<SoulAnchor[]>;
  getCachedAnchorIds(visitorKey: string): Promise<string[]>;
  getAnchorsByIds(ids: string[]): Promise<SoulAnchor[]>;
}
```

- [ ] **Step 2: 更新测试桩到可编译**

给 `packages/server/test/reasoning/engine.test.ts` 的 mock deps 补上：

- `countAnchors: vi.fn().mockResolvedValue(0)`
- `listAnchors: vi.fn().mockResolvedValue([])`
- `saveMessage` 接受新增第五个参数但先忽略

这一步目标是让后续失败来自业务断言，而不是 TS/fixture 缺口。

- [ ] **Step 3: 运行单测确认失败集中在业务逻辑**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: FAIL，但失败原因是新业务断言未满足，而不是接口缺失

### Task 4: 只实现 engine 的分支判断骨架

**Files:**

- Modify: `packages/server/src/reasoning/engine.ts`
- Test: `packages/server/test/reasoning/engine.test.ts`

- [ ] **Step 1: 写失败测试，要求阈值内时不进入 Recall 路径**

新增测试：`countAnchors()` 返回 `threshold - 1`，断言：

- `getCachedAnchorIds` 未调用
- `chatClient.chat` 未调用
- `embeddingClient?.embed` 未调用

- [ ] **Step 2: 写失败测试，要求冷启动路径不发 thinking**

新增测试：`emitThinking` 使用 `vi.fn()`，冷启动成功后断言调用次数为 `0`。

- [ ] **Step 3: 最小实现分支判断**

在 `handleMessage()` 中先加入：

```typescript
const anchorCount = await this.deps.countAnchors();
const useFullInjection = anchorCount <= REASONING_FULL_INJECTION_THRESHOLD;
```

先只把 Recall 路径包进 `if (!useFullInjection)`，并在 full-injection 分支暂时用 `listAnchors()` 取锚点，先不处理日志和持久化策略字段。

- [ ] **Step 4: 运行单测确认通过**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: 新增的“分支判断 / 不发 thinking”测试 PASS

### Task 5: 实现冷启动全量注入的回复生成

**Files:**

- Modify: `packages/server/src/reasoning/engine.ts`
- Test: `packages/server/test/reasoning/engine.test.ts`

- [ ] **Step 1: 写失败测试，要求冷启动路径使用全部锚点**

新增测试：

```typescript
it("uses all anchors for full injection when anchor count is below threshold", async () => {
  // countAnchors -> 2
  // listAnchors -> [a1, a2]
  // assert chatStream gets system prompt containing both anchor questions
});
```

- [ ] **Step 2: 写失败测试，要求冷启动路径在无 embeddingClient 时仍可成功**

新增测试：`embeddingClient` 传 `undefined`，`countAnchors()` 返回 `0`，断言仍有 token 与 done 事件。

- [ ] **Step 3: 实现冷启动锚点注入最小逻辑**

在 full-injection 分支中：

- `const anchors = await this.deps.listAnchors();`
- `const systemPrompt = buildAvatarSystemPrompt(anchors);`
- 继续复用现有 `chatStream` 回复生成流程

- [ ] **Step 4: 运行单测确认通过**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: 冷启动注入测试 PASS

### Task 6: 保持 Recall 路径原行为，并在缺 embeddingClient 时抛明确错误

**Files:**

- Modify: `packages/server/src/reasoning/engine.ts`
- Test: `packages/server/test/reasoning/engine.test.ts`

- [ ] **Step 1: 写失败测试，要求 Recall 路径保持原行为**

新增测试：`countAnchors()` 返回 `threshold + 1`，断言 `getCachedAnchorIds` 被调用、`chatClient.chat` 被用于 recall judgment、`embeddingClient?.embed` 被调用。

- [ ] **Step 2: 写失败测试，要求 Recall 路径缺少 embeddingClient 时给出明确错误**

新增测试：`countAnchors()` 返回 `threshold + 1`，`embeddingClient` 为 `undefined`，断言 `emitError` 收到 `LLM_ERROR` 且 message 包含 `Embedding client not configured for recall path`。

- [ ] **Step 3: 实现 Recall 路径守卫与原行为保留**

在 `handleMessage()` 中按以下顺序重构：

1. `saveMessage(visitorKey, "user", content)`
2. `getMessages(visitorKey, WINDOW_SIZE)`
3. `countAnchors()`
4. 若 `anchorCount <= REASONING_FULL_INJECTION_THRESHOLD`
   - `listAnchors()`
   - 设定 `anchorSelectionStrategy = "full-injection"`
   - 不调用 `getCachedAnchorIds()` / `batchRecall`
5. 否则
   - 若 `embeddingClient` 缺失，抛出 `new Error("Embedding client not configured for recall path")`
   - `getCachedAnchorIds()` -> `getAnchorsByIds()`
   - `batchRecall(...)`
   - 设定 `anchorSelectionStrategy = "batch-recall"`

用一个局部对象承载结果，避免复制粘贴：

```typescript
const anchorSelection = {
  strategy,
  anchors,
};
```

- [ ] **Step 4: 运行单测确认通过**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: Recall 行为和缺 embeddingClient 错误测试 PASS

### Task 7: 保存 assistant 消息时写入策略标记

**Files:**

- Modify: `packages/server/src/reasoning/engine.ts`
- Test: `packages/server/test/reasoning/engine.test.ts`

- [ ] **Step 1: 写失败测试，要求 assistant 保存 full-injection 标记**

新增测试：冷启动成功后断言 `saveMessage` 第二次（assistant）调用的第五个参数是 `"full-injection"`。

- [ ] **Step 2: 写失败测试，要求 assistant 保存 batch-recall 标记**

新增测试：Recall 路径成功后断言 `saveMessage` 第二次调用的第五个参数是 `"batch-recall"`。

- [ ] **Step 3: 实现 assistant 持久化策略标记**

在 `saveMessage()` 的 assistant 调用中传入：

```typescript
await this.deps.saveMessage(
  visitorKey,
  "assistant",
  fullContent,
  anchorIds,
  anchorSelection.strategy,
);
```

- [ ] **Step 4: 运行单测确认通过**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: assistant 策略标记测试 PASS

### Task 8: 增加结构化日志

**Files:**

- Modify: `packages/server/src/reasoning/engine.ts`
- Test: `packages/server/test/reasoning/engine.test.ts`

- [ ] **Step 1: 最小实现日志字段**

在 `engine.ts` 里增加 debug/info 日志，至少包含：

```typescript
{
  anchorCount,
  selectionStrategy,
  selectedAnchors: anchorIds.length,
  promptChars: systemPrompt.length,
}
```

不要改变现有日志事件名，优先扩展字段。

- [ ] **Step 2: 运行 engine 单测确认通过**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: PASS

---

## Chunk 3: Route 数据源、cache 过滤与兼容性

### Task 9: 放宽入口依赖校验

**Files:**

- Modify: `packages/server/src/routes/reasoning.ts`
- Test: `packages/server/test/routes/reasoning.test.ts`

- [ ] **Step 1: 写失败测试，要求冷启动时 route 不因缺少 embeddingClient 返回 500**

在 `packages/server/test/routes/reasoning.test.ts` 新增测试：`chatClient` 存在、`embeddingClient` 缺失、锚点总数低于阈值时，请求不会在 route 入口直接返回 500。

- [ ] **Step 2: 放宽入口依赖校验**

把 `POST /reasoning/message` 的入口校验从：

```typescript
if (!chatClient || !embeddingClient) { ... }
```

改成：

```typescript
if (!chatClient) { ... }
```

保持错误码 `LLM_ERROR` 不变。

- [ ] **Step 3: 运行 route 单测确认通过**

Run: `npx vitest run packages/server/test/routes/reasoning.test.ts`
Expected: PASS

### Task 10: 在路由层补 count/list/save 能力

**Files:**

- Modify: `packages/server/src/routes/reasoning.ts`
- Test: `packages/server/test/routes/reasoning.test.ts`

- [ ] **Step 1: 写失败测试，要求 populated response 映射仍正确**

在 `packages/server/test/routes/reasoning.test.ts` 中 seed 至少 1 条 reasoning message，断言 `GET /reasoning/messages` 返回 populated item，且字段映射仍为：

- `visitor_key`
- `created_at`
- `recalled_anchors`

- [ ] **Step 2: 实现 `countAnchors()` 与 `listAnchors()`**

在 `createEngine()` 依赖对象中新增：

```typescript
async countAnchors(): Promise<number> {
  const row = conn.drizzle
    .select({ count: sql<number>`count(*)` })
    .from(soulAnchors)
    .get();
  return Number(row?.count ?? 0);
}

async listAnchors(limit?: number): Promise<SoulAnchor[]> {
  const base = conn.drizzle
    .select()
    .from(soulAnchors)
    .orderBy(desc(soulAnchors.updatedAt), desc(soulAnchors.createdAt));
  return (limit ? base.limit(limit) : base).all() as SoulAnchor[];
}
```

- [ ] **Step 3: 扩展 `saveMessage()` 持久化策略标记**

把 `saveMessage()` 签名和 insert `.values()` 一并扩展，写入 `anchorSelectionStrategy`。

- [ ] **Step 4: 运行 route 单测确认通过**

Run: `npx vitest run packages/server/test/routes/reasoning.test.ts`
Expected: PASS

### Task 11: 过滤 cache 来源并兼容历史 `NULL` 消息

**Files:**

- Modify: `packages/server/src/routes/reasoning.ts`
- Test: `packages/server/test/routes/reasoning.test.ts`

- [ ] **Step 1: 写失败测试，要求历史 `NULL` 策略消息仍可作为 cache 来源**

seed 一条 assistant reasoning message：

- `recalled_anchors = ["a1"]`
- `anchor_selection_strategy = NULL`

然后走会触发 cache 读取的请求路径，断言后续 engine 能读到该缓存来源。

- [ ] **Step 2: 写失败测试，要求 `full-injection` 消息不会作为 cache 来源**

seed 一条 assistant reasoning message：

- `recalled_anchors = ["a1", "a2"]`
- `anchor_selection_strategy = 'full-injection'`

断言它不会被当成缓存回填。

- [ ] **Step 3: 实现 cache 过滤规则**

把 `getCachedAnchorIds()` 改成查询最近一条满足以下条件的 assistant 消息：

- `role = 'assistant'`
- `anchor_selection_strategy = 'batch-recall' OR anchor_selection_strategy IS NULL`

只解析该消息的 `recalledAnchors`。这样可以兼容旧版本历史消息，同时排除新引入的冷启动全量注入消息。

- [ ] **Step 4: 运行 route 单测确认通过**

Run: `npx vitest run packages/server/test/routes/reasoning.test.ts`
Expected: PASS

### Task 12: 保持 API 和 SSE 结构兼容

**Files:**

- Modify: `packages/server/src/routes/reasoning.ts`
- Test: `packages/server/test/routes/reasoning.test.ts`
- Test: `test/reasoning-integration.test.ts`

- [ ] **Step 1: 先建立 integration fixture**

在 `test/reasoning-integration.test.ts` 中补最小工具：

- fake `chatClient`（`chatStream` yield 固定 token，`chat` 按需返回 judgment）
- 可选 fake `embeddingClient`
- seed anchor helper（直接往 owner 的 DB 插入 `soul_anchors`，需要 Recall 测试时再补向量）
- SSE 文本解析 helper（把 `event:` / `data:` 解析成数组）

先让 helper 单独可用，再写行为测试。

- [ ] **Step 2: 写失败测试，要求 `/reasoning/messages` 仍只暴露 `recalled_anchors`**

新增测试：创建一条带 `anchor_selection_strategy` 的 reasoning message，调用 `GET /api/:pubKey/reasoning/messages`，断言返回体里没有 `anchorSelectionStrategy` 或其它新内部字段。

- [ ] **Step 3: 写失败测试，要求 SSE done 结构不变**

使用新的 SSE helper 调用成功的冷启动推理请求，断言 `done` 数据仍然只有 `messageId` 和 `recalledAnchors`。

- [ ] **Step 4: 调整 messages 映射层隐藏内部字段**

在 `GET /reasoning/messages` 的 `.map()` 里显式丢弃 `anchorSelectionStrategy`，和当前隐藏 `recalledAnchors` / `visitorKey` 的做法保持一致。

- [ ] **Step 5: 运行集成测试确认通过**

Run: `npx vitest run test/reasoning-integration.test.ts`
Expected: PASS

---

## Chunk 4: 回归验证

### Task 13: 跑完整相关测试集

**Files:**

- Test: `packages/server/test/db/migrate.test.ts`
- Test: `packages/server/test/reasoning/engine.test.ts`
- Test: `packages/server/test/routes/reasoning.test.ts`
- Test: `test/reasoning-integration.test.ts`
- Test: `packages/server/test/reasoning/batch-recall.test.ts`

- [ ] **Step 1: 跑冷启动相关测试集**

Run: `npx vitest run packages/server/test/db/migrate.test.ts packages/server/test/reasoning/engine.test.ts packages/server/test/routes/reasoning.test.ts test/reasoning-integration.test.ts packages/server/test/reasoning/batch-recall.test.ts`
Expected: ALL PASS

- [ ] **Step 2: 跑全量测试集**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 3: 跑 lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/db/schema.ts packages/server/src/db/migrate.ts packages/server/src/reasoning/constants.ts packages/server/src/reasoning/engine.ts packages/server/src/routes/reasoning.ts packages/server/test/db/migrate.test.ts packages/server/test/reasoning/engine.test.ts packages/server/test/routes/reasoning.test.ts test/reasoning-integration.test.ts docs/superpowers/plans/2026-03-22-reasoning-cold-start.md
git commit -m "feat(server): add cold-start full injection for reasoning"
```
