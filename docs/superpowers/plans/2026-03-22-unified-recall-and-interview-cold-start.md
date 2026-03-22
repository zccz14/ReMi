# 统一 Recall Runtime 与访谈冷启动实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 interview / reasoning 的 Recall 收敛为统一的 goal-based recall runtime，并让访谈流程在少锚点冷启动阶段跳过 Recall loop，直接全量注入锚点，同时保持 reasoning 的 cache / 审计语义不变。

**Architecture:** 新增一个公共 recall runtime，统一处理 goals、冷启动全量注入、Recall loop 与 judgment 解析；reasoning 与 interview 都切换到该 runtime，但各自保留业务层职责。reasoning 继续在业务层构造 `initialAnchors` 并把 runtime 内部 `strategy` 映射成现有落库语义；interview 只消费 recall 结果优化前摇，不新增 `recalled_anchors` 持久化，也不改变 route / message 流程整体对 embedding 的依赖边界。

**Tech Stack:** TypeScript, Hono SSE, drizzle-orm, better-sqlite3, vitest

**Spec:** `docs/superpowers/specs/2026-03-22-unified-recall-and-interview-cold-start-design.md`

---

## 文件结构

```text
packages/server/src/
├── recall/
│   ├── constants.ts                 # 新增：统一 recall 域阈值
│   └── goal-based-recall.ts         # 新增：公共 runtime
├── interview/
│   ├── constants.ts                 # 新增：固定 interview goals 常量
│   ├── engine.ts                    # 修改：start/message 都接入统一 runtime
│   └── prompts.ts                   # 修改：统一为 goals 数组协议
├── reasoning/
│   ├── engine.ts                    # 修改：接入统一 runtime，保留 cache / strategy 落库映射
│   ├── prompts.ts                   # 修改：接入统一 goals judgment builder / parser
│   └── constants.ts                 # 修改：如有需要，删掉局部阈值改走 recall/constants.ts
├── routes/
│   ├── interview.ts                 # 修改：固定稳定排序，并锁住现有 embedding 依赖边界
│   └── reasoning.ts                 # 修改：继续做 cache 过滤与 strategy 落库映射

packages/server/test/
├── recall/
│   └── goal-based-recall.test.ts    # 新增：公共 runtime 单测
├── interview/
│   ├── engine.test.ts               # 修改：迁移 mock 入口，覆盖 start/message 冷启动
│   └── prompts.test.ts              # 可选新增：固定单 goal 文案与 goals 协议
├── reasoning/
│   └── engine.test.ts               # 修改：验证统一 runtime + strategy 映射不变
└── routes/
    ├── interview.test.ts            # 修改：锁住 route 级 embedding 依赖边界与排序
    └── reasoning.test.ts            # 修改：回归 legacy cache / SSE / mapping

test/
├── interview-integration.test.ts    # 修改：回归 interview 冷启动协议与 route 边界
└── reasoning-integration.test.ts    # 修改：回归 reasoning cache / SSE 兼容
```

---

## Chunk 1: 公共 Runtime 只做通用能力

### Task 1: 新建 recall 域常量与 runtime 测试夹具

**Files:**

- Create: `packages/server/src/recall/constants.ts`
- Create: `packages/server/src/recall/goal-based-recall.ts`
- Create: `packages/server/test/recall/goal-based-recall.test.ts`

- [ ] **Step 1: 写失败测试，要求阈值内直接 full injection**

新增测试：`countAnchors -> threshold`，`listAnchors -> [a1, a2]`，断言：

- `strategy === "full-injection"`
- `embeddingClient` 未调用
- judgment chat 未调用

- [ ] **Step 2: 写失败测试，要求超阈值进入 recall loop**

新增测试：`countAnchors -> threshold + 1`，断言 `embeddingClient.embed` 与 judgment chat 被调用。

- [ ] **Step 3: 写失败测试，要求 initialAnchors 参与补足**

新增测试：传入 `initialAnchors = [a1]`，检索命中 `[a2]`，断言最终结果包含两者。

- [ ] **Step 4: 写失败测试，要求缺 embeddingClient 且进入 recall loop 时抛明确错误**

断言错误包含 `Embedding client not configured for recall loop`。

- [ ] **Step 5: 写失败测试，要求 full injection 顺序稳定**

让 `listAnchors()` 返回固定排序数据，断言 runtime 原样返回该顺序。

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run packages/server/test/recall/goal-based-recall.test.ts`
Expected: FAIL

- [ ] **Step 7: 创建最小外壳与常量**

创建：

```typescript
export const RECALL_FULL_INJECTION_THRESHOLD = 20;
```

并导出 `goalBasedRecall()` 空函数骨架，使测试可编译。

- [ ] **Step 8: 再跑测试确认失败集中在行为断言**

Run: `npx vitest run packages/server/test/recall/goal-based-recall.test.ts`
Expected: FAIL，但不再是模块缺失

### Task 2: 把 runtime loop 拆成小步实现

**Files:**

- Modify: `packages/server/src/recall/goal-based-recall.ts`
- Test: `packages/server/test/recall/goal-based-recall.test.ts`

- [ ] **Step 1: 只实现 full injection 分支**

实现：

```typescript
if (anchorCount <= RECALL_FULL_INJECTION_THRESHOLD) {
  return {
    anchors: await listAnchors(),
    narratives: [],
    rounds: 0,
    sufficient: true,
    strategy: "full-injection",
  };
}
```

- [ ] **Step 2: 运行测试确认只有 full injection 用例通过**

Run: `npx vitest run packages/server/test/recall/goal-based-recall.test.ts`
Expected: full injection 相关 PASS，其余 recall-loop 相关仍 FAIL

- [ ] **Step 3: 实现 initialAnchors 初始化与去重**

先只把 `initialAnchors` 合并进 `Map`，不做 embedding / judgment。

- [ ] **Step 4: 运行测试确认 initialAnchors 用例仍失败在“未补足”而不是初始化**

Run: `npx vitest run packages/server/test/recall/goal-based-recall.test.ts`
Expected: initialAnchors 测试仍 FAIL，但可看出种子集合已进入结果路径

- [ ] **Step 5: 实现单轮 embed + search**

把：

- `context` 作为初始 query
- `embed -> searchAnchors`
- 命中 anchors 合并进 `Map`

- [ ] **Step 6: 运行测试确认 recall-loop 失败集中在 judgment/终止逻辑**

Run: `npx vitest run packages/server/test/recall/goal-based-recall.test.ts`
Expected: recall-loop 测试仍 FAIL，但嵌入与检索已发生

- [ ] **Step 7: 实现 judgment 解析与终止条件**

实现：

- `buildJudgmentPrompt`
- `parseJudgment`
- `sufficient/nextQuery`
- 缺 embedding 守卫

- [ ] **Step 8: 实现 narrative 收集与 onNarrative 回调**

只在 judgment 有 `narrative` 时 push 并回调。

- [ ] **Step 9: 运行 runtime 测试确认全部通过**

Run: `npx vitest run packages/server/test/recall/goal-based-recall.test.ts`
Expected: PASS

---

## Chunk 2: Interview 业务层独立接入

### Task 3: 固定 interview goals 常量，不把业务文案塞进 runtime

**Files:**

- Create: `packages/server/src/interview/constants.ts`
- Modify: `packages/server/src/interview/engine.ts`
- Test: `packages/server/test/interview/engine.test.ts`

- [ ] **Step 1: 写失败测试，要求 start/message 共用固定 interview goals 常量**

在 `packages/server/test/interview/engine.test.ts` 增加断言：`start()` 与 `handleMessage()` 都通过同一个固定 goals 数组调用新 runtime。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/server/test/interview/engine.test.ts`
Expected: FAIL，因为还在用旧 `agenticRecall`

- [ ] **Step 3: 创建 interview 常量模块**

创建：

```typescript
export const INTERVIEW_RECALL_GOALS = ["充分理解本体在当前话题的认知，问出好问题"] as const;
```

- [ ] **Step 4: 在 engine 中只接上常量导入**

先不改主流程，保证常量位置固定。

- [ ] **Step 5: 再跑测试确认失败集中在调用入口**

Run: `npx vitest run packages/server/test/interview/engine.test.ts`
Expected: FAIL，但不再是常量缺失

### Task 4: 迁移 interview `start()` 到统一 runtime

**Files:**

- Modify: `packages/server/src/interview/engine.ts`
- Test: `packages/server/test/interview/engine.test.ts`

- [ ] **Step 1: 写失败测试，要求 `start()` 走统一 runtime 而不是旧 recall**

新增测试：mock 新 runtime，调用 `start()`，断言：

- 使用 `INTERVIEW_RECALL_GOALS`
- 在少锚点时不触发 recall thinking

- [ ] **Step 2: 修改 `start()` 接口调用**

把旧 `agenticRecall` 替换为 `goalBasedRecall()`。

- [ ] **Step 3: 运行 start 相关测试确认通过**

Run: `npx vitest run packages/server/test/interview/engine.test.ts`
Expected: `start()` 相关测试 PASS

### Task 5: 迁移 interview `handleMessage()` 到统一 runtime

**Files:**

- Modify: `packages/server/src/interview/engine.ts`
- Modify: `packages/server/src/interview/prompts.ts`
- Test: `packages/server/test/interview/engine.test.ts`

- [ ] **Step 1: 写失败测试，要求少锚点时 message 不进入 recall loop**

新增测试：

- `getAnchorCount() -> threshold`
- 不调用 recall-loop 相关 embedding/judgment
- 不发 recall narrative

- [ ] **Step 2: 写失败测试，要求少锚点时主持人 prompt 使用全部锚点**

让 `getAnchors()` 返回 `[a1, a2]`，断言 `chatStream` system prompt 同时包含两者。

- [ ] **Step 3: 写失败测试，要求最近消息仍正常注入**

断言系统 prompt 之外，chat messages 仍含最近对话。

- [ ] **Step 4: 把 interview judgment prompt 改成 goals 数组协议**

让 prompt builder 接收：

```typescript
goals: string[]
```

并在 prompt 文本中列出 goals 列表。

- [ ] **Step 5: 将 `handleMessage()` 改成调用统一 runtime**

只改 Recall 子流程；保持提取、矛盾检测、保存新锚点等其余链路不变。

- [ ] **Step 6: 明确不放宽 message embedding 边界**

不要修改：

- `EngineDeps.embeddingClient`
- `saveAnchors()` 的向量写入依赖

- [ ] **Step 7: 运行 interview engine 测试确认通过**

Run: `npx vitest run packages/server/test/interview/engine.test.ts`
Expected: PASS

### Task 6: 锁住 interview route 级依赖边界与排序

**Files:**

- Modify: `packages/server/src/routes/interview.ts`
- Test: `packages/server/test/routes/interview.test.ts`
- Test: `test/interview-integration.test.ts`

- [ ] **Step 1: 写失败测试，要求 `/interview/start` 缺 embedding 时仍保持当前失败边界**

断言：缺 `embeddingClient` 时仍返回现有 `LLM_ERROR`。

- [ ] **Step 2: 写失败测试，要求 `/interview/message` 缺 embedding 时仍保持当前失败边界**

断言：缺 `embeddingClient` 时仍返回现有 `LLM_ERROR`。

- [ ] **Step 3: 写失败测试，要求 `getAnchors()` full injection 顺序稳定**

优先在 `packages/server/test/routes/interview.test.ts` 里写，integration 只保留一条端到端回归。

- [ ] **Step 4: 修改 `getAnchors()` 为稳定排序**

改成：

```typescript
select()
  .from(soulAnchors)
  .orderBy(desc(soulAnchors.updatedAt), desc(soulAnchors.createdAt))
  .limit(limit);
```

- [ ] **Step 5: 运行 interview route / integration 测试确认通过**

Run: `npx vitest run packages/server/test/routes/interview.test.ts test/interview-integration.test.ts`
Expected: PASS

---

## Chunk 3: Reasoning 业务层独立接入

### Task 7: 建立 runtime strategy 到 reasoning 落库 strategy 的显式映射

**Files:**

- Modify: `packages/server/src/reasoning/constants.ts`
- Modify: `packages/server/src/reasoning/engine.ts`
- Test: `packages/server/test/reasoning/engine.test.ts`

- [ ] **Step 1: 写失败测试，要求 `full-injection -> full-injection`**

断言冷启动时 assistant 持久化仍写 `"full-injection"`。

- [ ] **Step 2: 写失败测试，要求 `recall-loop -> batch-recall`**

断言超阈值 recall-loop 结束后 assistant 持久化写的是 `"batch-recall"`。

- [ ] **Step 3: 引入显式映射 helper/常量**

例如：

```typescript
function mapRecallRuntimeStrategyToReasoningStrategy(...) { ... }
```

- [ ] **Step 4: 运行 reasoning engine 测试确认映射用例通过**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: 映射相关用例 PASS

### Task 8: 迁移 reasoning 到统一 runtime

**Files:**

- Modify: `packages/server/src/reasoning/engine.ts`
- Modify: `packages/server/src/reasoning/prompts.ts`
- Test: `packages/server/test/reasoning/engine.test.ts`

- [ ] **Step 1: 写失败测试，要求仍传多 goals**

断言统一 runtime 调用拿到的 goals 数组长度仍与当前多目标集合一致。

- [ ] **Step 2: 写失败测试，要求 legacy NULL / full-injection cache 语义保持不变**

保持现有 engine/route 回归断言，确保不会因 runtime 替换而退化。

- [ ] **Step 3: 将 reasoning engine 改成调用统一 runtime**

保留：

- `initialAnchors` 构造
- `getCachedAnchorIds()` 过滤逻辑
- `getAnchorsByIds()` 顺序恢复
- assistant message 的 `recalled_anchors`
- 上一步新增的 strategy 映射 helper

- [ ] **Step 4: 运行 reasoning engine 测试确认通过**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: PASS

### Task 9: 保持 reasoning route 与 integration 兼容

**Files:**

- Modify: `packages/server/src/routes/reasoning.ts`
- Test: `packages/server/test/routes/reasoning.test.ts`
- Test: `test/reasoning-integration.test.ts`

- [ ] **Step 1: 写失败测试，要求 legacy NULL cache 继续可用**

沿用现有夹具，确认新 runtime 接入后 legacy `NULL` 消息仍能作为 `initialAnchors` 来源。

- [ ] **Step 2: 写失败测试，要求 full-injection 历史消息仍不污染 cache**

保持现有 route / integration 回归断言。

- [ ] **Step 3: 运行 reasoning route / integration 测试确认通过**

Run: `npx vitest run packages/server/test/routes/reasoning.test.ts test/reasoning-integration.test.ts`
Expected: PASS

---

## Chunk 4: 删除旧实现与全链路回归

### Task 10: 在所有新回归稳定后删除旧 recall 文件与旧专属测试

**Files:**

- Delete: `packages/server/src/interview/recall.ts`
- Delete: `packages/server/src/reasoning/batch-recall.ts`
- Delete: `packages/server/test/interview/recall.test.ts`
- Delete: `packages/server/test/reasoning/batch-recall.test.ts`

- [ ] **Step 1: 先确认前置条件已满足**

前置条件：

- `packages/server/test/recall/goal-based-recall.test.ts` 已通过
- `packages/server/test/interview/engine.test.ts` 已通过
- `packages/server/test/reasoning/engine.test.ts` 已通过
- route / integration 回归已通过

- [ ] **Step 2: 删除旧文件与旧测试**

仅在上面前置条件满足后执行删除。

- [ ] **Step 3: 运行相关测试确认删除后仍通过**

Run: `npx vitest run packages/server/test/recall/goal-based-recall.test.ts packages/server/test/interview/engine.test.ts packages/server/test/reasoning/engine.test.ts packages/server/test/routes/interview.test.ts packages/server/test/routes/reasoning.test.ts test/interview-integration.test.ts test/reasoning-integration.test.ts`
Expected: PASS

### Task 11: 跑完整相关测试集

**Files:**

- Test: `packages/server/test/recall/goal-based-recall.test.ts`
- Test: `packages/server/test/interview/engine.test.ts`
- Test: `packages/server/test/reasoning/engine.test.ts`
- Test: `packages/server/test/routes/interview.test.ts`
- Test: `packages/server/test/routes/reasoning.test.ts`
- Test: `test/interview-integration.test.ts`
- Test: `test/reasoning-integration.test.ts`

- [ ] **Step 1: 跑统一 recall 与双链路相关测试集**

Run: `npx vitest run packages/server/test/recall/goal-based-recall.test.ts packages/server/test/interview/engine.test.ts packages/server/test/reasoning/engine.test.ts packages/server/test/routes/interview.test.ts packages/server/test/routes/reasoning.test.ts test/interview-integration.test.ts test/reasoning-integration.test.ts`
Expected: ALL PASS

- [ ] **Step 2: 跑全量测试集**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 3: 跑 lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/recall packages/server/src/interview/constants.ts packages/server/src/interview/engine.ts packages/server/src/interview/prompts.ts packages/server/src/reasoning/engine.ts packages/server/src/reasoning/prompts.ts packages/server/src/reasoning/constants.ts packages/server/src/routes/interview.ts packages/server/src/routes/reasoning.ts packages/server/test/recall/goal-based-recall.test.ts packages/server/test/interview/engine.test.ts packages/server/test/routes/interview.test.ts packages/server/test/reasoning/engine.test.ts packages/server/test/routes/reasoning.test.ts test/interview-integration.test.ts test/reasoning-integration.test.ts docs/superpowers/specs/2026-03-22-unified-recall-and-interview-cold-start-design.md docs/superpowers/plans/2026-03-22-unified-recall-and-interview-cold-start.md
git rm packages/server/src/interview/recall.ts packages/server/src/reasoning/batch-recall.ts packages/server/test/interview/recall.test.ts packages/server/test/reasoning/batch-recall.test.ts
git commit -m "refactor(server): unify recall runtime and optimize interview cold start"
```
