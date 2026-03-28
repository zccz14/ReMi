# 推理编排与锚点召回增强 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为推理链路加入 query decomposition、goal-driven recall assessment、时间语境、无增益提前停止和最近一次推理样本落盘，同时保持现有 SSE 对外协议稳定。

**Architecture:** `ReasoningEngine` 从“直接 recall + 生成”升级为“decomposition -> recall assessment -> constrained generation -> debug artifact”。`goalBasedRecall` 负责统一 full-injection 与 recall-loop 两条路径的归一化状态输出；`reasoning/prompts.ts` 负责结构化 prompt builder；`debug-artifact.ts` 负责原子化写入 `debug/reasoning-last/`。实现时先锁定协议与回退策略，再接入 engine 主流程，最后补可观测性与性能护栏。

**Tech Stack:** TypeScript, Hono SSE, drizzle-orm, better-sqlite3, vitest, Node fs/promises

**Spec:** `docs/superpowers/specs/2026-03-28-reasoning-orchestration-and-anchor-recall-design.md`

---

## 文件结构

```text
packages/server/src/
├── avatar/
│   └── runtime.ts                   # 回归检查：shared recall runtime 兼容性
├── interview/
│   └── engine.ts                    # 回归检查：shared recall runtime 兼容性
├── reasoning/
│   ├── debug-artifact.ts            # 新增：最近一次推理样本原子化落盘
│   ├── engine.ts                    # 修改：主编排接线、回退、日志、debug artifact
│   ├── prompts.ts                   # 修改：decomposition / judgment / generation prompt builders
│   └── time.ts                      # 可选新增：currentTime 格式化辅助（若 prompts/engine 过重）
├── recall/
│   ├── goal-based-recall.ts         # 修改：归一化 goalStatus、stoppedBecause、roundSummaries
│   └── constants.ts                 # 修改：missingKeys 常量、停止原因常量
└── routes/
    └── reasoning.ts                 # 修改：注入 debug artifact 配置/依赖（如需要）

packages/server/test/
├── avatar/
│   └── runtime.test.ts              # 新增：shared recall runtime 返回结构未破坏 avatar runtime
├── interview/
│   └── engine.test.ts               # 回归：shared recall runtime 返回结构未破坏 interview
├── reasoning/
│   ├── engine.test.ts               # 修改：主流程、回退、artifact、full-injection/recall-loop
│   └── prompts.test.ts              # 新增：结构化 prompt contract
└── recall/
    └── goal-based-recall.test.ts    # 修改：normalized goalStatus、early stop、runtime authority
```

---

## Chunk 1: 协议与常量先行

### Task 0: 先锁 shared recall runtime 的兼容性边界

**Files:**

- Test: `packages/server/test/interview/engine.test.ts`
- Create: `packages/server/test/avatar/runtime.test.ts`

- [ ] **Step 1: 写回归测试，锁定 interview 仍可消费扩展后的 shared runtime**

在 `packages/server/test/interview/engine.test.ts` 补一条测试：当 `goalBasedRecall()` 返回新增字段（如 `goalStatus`、`stoppedBecause`、`roundSummaries`）时，interview 流程仍能完成主持人生成，而不会因结果结构扩展报错。

- [ ] **Step 2: 写回归测试，锁定 avatar runtime 仍可消费扩展后的 shared runtime**

创建 `packages/server/test/avatar/runtime.test.ts`，直接覆盖 `AvatarInferenceRuntime.createRequest()` 或其 recall 消费路径：当 `goalBasedRecall()` 返回新增字段（如 `goalStatus`、`stoppedBecause`、`roundSummaries`）时，avatar runtime 仍能成功生成 request，并把 `recall.anchors` 正常转成 downstream recall segment。

- [ ] **Step 3: 运行回归测试确认当前行为被锁住**

Run: `npx vitest run packages/server/test/interview/engine.test.ts packages/server/test/avatar/runtime.test.ts`
Expected: PASS

- [ ] **Step 4: 后续每次改动 `goalBasedRecall()` 后都重复运行这组回归测试**

Run: `npx vitest run packages/server/test/interview/engine.test.ts packages/server/test/avatar/runtime.test.ts`
Expected: PASS

### Task 1: 为 recall runtime 定义归一化协议与常量

**Files:**

- Modify: `packages/server/src/recall/constants.ts`
- Modify: `packages/server/src/recall/goal-based-recall.ts`
- Test: `packages/server/test/recall/goal-based-recall.test.ts`

- [ ] **Step 1: 写失败测试，要求 full-injection 返回归一化元数据**

在 `packages/server/test/recall/goal-based-recall.test.ts` 新增测试，断言当 `countAnchors()` 小于等于阈值时，结果除了 `anchors/strategy` 之外，还包含：

```ts
expect(result).toEqual(
  expect.objectContaining({
    strategy: "full-injection",
    rounds: 0,
    stoppedBecause: "sufficient",
    goalStatus: expect.any(Array),
    roundSummaries: [],
  }),
);
```

- [ ] **Step 2: 写失败测试，要求 runtime 而不是模型决定最终 sufficient**

新增测试：模型 judgment 返回 `sufficient: true`，但某个 required goal 的 `missingKeys` 非空；断言最终结果 `sufficient === false`。

- [ ] **Step 3: 写失败测试，要求缺失 required goal 时自动回填**

新增测试：解析结果中故意漏掉某个 required goal，断言 runtime 会补成：

```ts
expect(result.goalStatus).toContainEqual(
  expect.objectContaining({
    goalId: "domain_answer",
    sufficient: false,
    missingKeys: ["unassessed-required-goal"],
  }),
);
```

- [ ] **Step 3.5: 写失败测试，要求未知 `missingKeys` 先归一化为 `other`**

新增测试：模型返回一个不在受控词表内的 `missingKeys`，断言 runtime 归一化结果为 `other`，并且后续 `no-missing-reduced` 的比较基于归一化后的 key 集合。

- [ ] **Step 4: 运行测试确认失败**

Run: `npx vitest run packages/server/test/recall/goal-based-recall.test.ts`
Expected: FAIL，提示结果结构或 sufficient 语义不匹配

- [ ] **Step 5: 定义常量与类型**

在 `packages/server/src/recall/constants.ts` 新增：

```ts
export const RECALL_STOP_REASONS = {
  SUFFICIENT: "sufficient",
  NO_NEW_ANCHORS: "no-new-anchors",
  NO_MISSING_REDUCED: "no-missing-reduced",
  EMPTY_NEXT_QUERY: "empty-next-query",
  PARSE_FAILURE: "parse-failure",
  MAX_ROUNDS: "max-rounds",
} as const;

export const RECALL_MISSING_KEYS = [
  "identity-unknown",
  "style-unknown",
  "visitor-relationship",
  "visitor-boundary",
  "domain-fact-missing",
  "domain-preference-missing",
  "recent-position",
  "time-validity-uncertain",
  "unassessed-required-goal",
  "other",
] as const;
```

同时在 `goal-based-recall.ts` 顶部或相邻位置声明最小协议类型：

```ts
type GoalStatus = {
  goalId: string;
  sufficient: boolean;
  knownAnchorIds: string[];
  missingKeys: string[];
  known?: string[];
  missing?: string[];
};

type RecallRoundSummary = {
  round: number;
  query: string;
  newAnchorIds: string[];
  allAnchorIds: string[];
  normalizedGoalStatus: GoalStatus[];
  stoppedCandidate?: string;
};
```

- [ ] **Step 6: 最小实现 runtime authority 与 required-goal backfill**

在 `goalBasedRecall()` 内新增归一化辅助：

```ts
function normalizeGoalStatuses(/* parsed status + required goals */): GoalStatus[];
function computeOverallSufficient(statuses: GoalStatus[]): boolean;
```

要求：

- 所有 required goal 都必须出现在最终 `goalStatus`
- 未知 `missingKeys` 归一化为 `other`
- 模型省略 required goal 时补 `unassessed-required-goal`
- 最终 `sufficient` 由 `computeOverallSufficient()` 计算
- 对旧调用方保持返回结构向后兼容：新增字段只追加，不删除现有 `anchors/narratives/rounds/sufficient/strategy`

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run packages/server/test/recall/goal-based-recall.test.ts`
Expected: PASS

### Task 2: 为无增益提前停止补齐 runtime 行为

**Files:**

- Modify: `packages/server/src/recall/goal-based-recall.ts`
- Test: `packages/server/test/recall/goal-based-recall.test.ts`

- [ ] **Step 1: 写失败测试，要求无新增锚点时提前停止**

新增测试：`searchAnchors()` 返回空数组、judgment 仍给出 `nextQuery`，断言：

```ts
expect(result.stoppedBecause).toBe("no-new-anchors");
expect(result.rounds).toBe(1);
```

- [ ] **Step 2: 写失败测试，要求 missing 没有缩减时提前停止**

新增测试：两轮 judgment 的归一化 `missingKeys` 完全相同，但第二轮搜到的是无助于缩减 missing 的锚点；断言：

```ts
expect(result.stoppedBecause).toBe("no-missing-reduced");
```

- [ ] **Step 3: 写失败测试，要求 parse failure 走确定性回退**

新增测试：`parseJudgment()` 返回非法结构或抛错，断言 runtime 最终：

```ts
expect(result.stoppedBecause).toBe("parse-failure");
expect(result.sufficient).toBe(false);
```

- [ ] **Step 3.2: 写失败测试，要求 judgment parse failure 最多只重试一次**

新增测试：第一次 `parseJudgment()` 失败、第二次成功时，断言 runtime 会重试一次并继续；如果两次都失败，则才落到 `parse-failure`。

- [ ] **Step 3.5: 写失败测试，要求 `empty-next-query` 的三种边界都被锁住**

补参数化测试覆盖：

- `nextQuery === ""`
- `nextQuery` 与上一轮完全相同
- `nextQuery` 去空白后与上一轮相同

断言统一为：

```ts
expect(result.stoppedBecause).toBe("empty-next-query");
```

本轮把 spec 里的“实质相同”收窄为可验证的最小规则：字符串相同或 trim 后相同；不在本轮引入语义等价判定。

- [ ] **Step 4: 运行测试确认失败**

Run: `npx vitest run packages/server/test/recall/goal-based-recall.test.ts`
Expected: FAIL

- [ ] **Step 5: 实现停止判定与 roundSummaries**

在每轮 recall 中记录：

- 本轮 query
- `newAnchorIds`
- 归一化后的 `goalStatus`
- 预判的 `stoppedCandidate`

然后补逻辑：

- `newAnchorIds.length === 0` -> `no-new-anchors`
- required goals 的 `missingKeys` 与上一轮归一化后完全一致 -> `no-missing-reduced`
- `nextQuery` 为空、重复或 trim 后相同 -> `empty-next-query`
- `parseJudgment()` 失败或返回不合法结构时先重试一次；第二次仍失败 -> `parse-failure`

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run packages/server/test/recall/goal-based-recall.test.ts`
Expected: PASS

---

## Chunk 2: Prompt contract 结构化

### Task 3: 拆分 reasoning prompt builders

**Files:**

- Modify: `packages/server/src/reasoning/prompts.ts`
- Test: `packages/server/test/reasoning/prompts.test.ts`

- [ ] **Step 1: 新建 prompts 测试文件并写失败测试**

创建 `packages/server/test/reasoning/prompts.test.ts`，先写 6 个失败测试：

1. `buildReasoningDecompositionPrompt()` 包含 `currentTime` 与原始 query
2. `buildReasoningJudgmentPrompt()` 包含 goals、anchors、`currentTime`
3. `buildReasoningGenerationPrompt()` 同时包含 `Evidence` 与 `Non-evidence reasoning` 两段，并要求 anchor 展示 `UpdatedAt`
4. `buildReasoningGenerationPrompt()` 明确写出“reasoning chain 不能作为 factual claim 的证据来源”
5. `buildReasoningGenerationPrompt()` 当 required missing 非空时，必须保留 `## Missing Information`
6. `buildReasoningGenerationPrompt()` 当 `temporal_validity` 不充分时，必须加入保守措辞约束

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/server/test/reasoning/prompts.test.ts`
Expected: FAIL，因为新 builder 尚不存在

- [ ] **Step 3: 在 `prompts.ts` 增加 builder 函数签名**

新增最小导出：

```ts
export function buildReasoningDecompositionPrompt(...): ChatMessage[]
export function buildReasoningJudgmentPrompt(...): ChatMessage[]
export function buildReasoningGenerationPrompt(...): string
```

保留现有 `buildAvatarSystemPrompt()`，但让它先委托到新 generation builder，避免大面积断链。

- [ ] **Step 4: 最小实现 decomposition / judgment prompt**

要求：

- decomposition prompt 明确输出 JSON，包含 `answerGoals` 与 `successCriteria`
- judgment prompt 也统一输出 JSON，而不是继续扩展 XML 协议
- judgment prompt 明确区分 required goals、当前 anchor、`currentTime`、`visitorKey`
- prompt 文案里加入“reasoning chain 不是事实证据”的硬规则

- [ ] **Step 5: 实现 generation prompt 的双通道结构**

最终字符串至少包含这些标题：

```text
## Current Time
## User Question
## Answer Goals
## Evidence
## Missing Information
## Non-evidence Reasoning
## Answering Rules
```

Evidence 中每条 anchor 必须渲染：

```text
- ID: a1
  Q: ...
  A: ...
  UpdatedAt: 2026-03-28T12:34:56.000Z
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run packages/server/test/reasoning/prompts.test.ts`
Expected: PASS

### Task 4: 为 decomposition / judgment 解析准备最小结构

**Files:**

- Modify: `packages/server/src/reasoning/engine.ts`
- Test: `packages/server/test/reasoning/engine.test.ts`

- [ ] **Step 1: 写失败测试，要求 decomposition parse 失败时回退默认 goals**

新增测试：mock decomposition 模型输出非法 JSON；断言 engine 仍然成功生成回复，并把默认 goals 传入后续判断路径。

- [ ] **Step 2: 写失败测试，要求 currentTime 进入最终 generation prompt**

通过 spy `chatClient.chatStream` 的入参，断言 system prompt 含 `## Current Time`。

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: FAIL

- [ ] **Step 4: 在 engine 中补最小解析辅助**

新增私有辅助方法，保持实现窄小：

```ts
private buildDefaultAnswerGoals(content: string): ...
private parseDecomposition(content: string, fallbackQuery: string): ...
private isoNow(): string
```

规则：

- `parseDecomposition()` 失败时回退默认 goals
- 如果原始 query 含“最近/现在/目前/变化/current/recent”等词，再补 `temporal_validity`
- decomposition 与 reasoning judgment 的新解析统一走 JSON；不要引入 XML / JSON 并存的新分叉

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: PASS

---

## Chunk 3: Engine 主编排接线

### Task 5: 让 engine 统一 full-injection 与 recall-loop 的 orchestration

**Files:**

- Modify: `packages/server/src/reasoning/engine.ts`
- Modify: `packages/server/src/reasoning/prompts.ts`
- Test: `packages/server/test/reasoning/engine.test.ts`

- [ ] **Step 1: 写失败测试，要求 full-injection 也产出 goalStatus/missing**

新增测试：`countAnchors()` 返回阈值内，断言 generation prompt 中既有 `## Evidence` 也有 `## Missing Information`，而不是只拼锚点列表。

- [ ] **Step 2: 写失败测试，要求 recall-loop 将 reasoning chain 注入 final prompt**

新增测试：mock judgment 返回 `reasoningChain`，断言 generation prompt 中存在 `## Non-evidence Reasoning` 且包含该链路。

- [ ] **Step 3: 写失败测试，要求模型 insufficient 时仍可生成保守回答**

新增测试：让 runtime 返回 `sufficient: false`、存在 required goal 缺口，断言依然调用 `chatStream()` 生成最终回答，而不是直接报错。

- [ ] **Step 4: 运行测试确认失败**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: FAIL

- [ ] **Step 5: 最小接线 decomposition -> recall assessment -> generation**

在 `handleMessage()` 中按顺序改造：

1. 保存 user message 后读取 messages
2. 生成 `currentTime`
3. 调用 decomposition prompt（单次 `chatClient.chat`）
4. 把 decomposition 结果传给 `goalBasedRecall()`
5. 将 runtime 返回的 `goalStatus`、`reasoningChain`、`stoppedBecause` 交给 generation prompt
6. 用新的 generation prompt 调 `chatStream()`

注意：

- full-injection 与 recall-loop 共用同一套 generation prompt
- full-injection 只是不进多轮 recall，不是不做 assessment

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: PASS

### Task 6: 锁定性能护栏与日志摘要

**Files:**

- Modify: `packages/server/src/reasoning/engine.ts`
- Test: `packages/server/test/reasoning/engine.test.ts`

- [ ] **Step 1: 写失败测试，要求日志摘要记录 stoppedBecause 和 round 数**

如果当前测试风格不直接断 logger，可改为断传入 debug artifact summary 的字段；至少要求摘要里有：`rounds`、`stoppedBecause`、`hasUnsatisfiedRequiredGoal`。

- [ ] **Step 2: 写失败测试，要求 full-injection 不额外走 recall embedding**

保留并强化现有边界测试：full-injection 时 `embeddingClient.embed` 与 recall judgment chat 不被调用。

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: FAIL

- [ ] **Step 4: 实现最小性能护栏**

在 engine 中：

- decomposition 只做 1 次模型调用
- full-injection 路径只做 1 次 decomposition + 1 次 assessment（若通过 runtime 实现）+ 1 次 generation
- 保留现有 recall threshold 语义，避免所有请求都进入多轮 recall
- 日志新增：`rounds`、`stoppedBecause`、`goalCount`、`promptChars`

- [ ] **Step 4.5: 写失败测试，要求 full-injection parity 不引入隐藏 recall 调用**

新增测试：full-injection 场景下除了 decomposition / assessment / generation 允许的 chat 调用外，不会额外触发 embedding 或多轮 recall judgment；通过断言 `chatClient.chat` 调用次数与 `embeddingClient.embed` 调用次数完成。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: PASS

---

## Chunk 4: 最近一次推理样本落盘

### Task 7: 新增 debug artifact writer

**Files:**

- Create: `packages/server/src/reasoning/debug-artifact.ts`
- Test: `packages/server/test/reasoning/engine.test.ts`

- [ ] **Step 1: 写失败测试，要求最近一次样本被原子覆盖**

在 engine 测试里使用临时目录，执行两次推理，断言第二次结束后：

- 目录存在 `summary.json`
- `summary.json.userQuery` 是第二次请求
- 不存在混合前后两次请求内容的残留文件断言

- [ ] **Step 1.2: 写失败测试，锁定 `summary.json` 的最小契约字段**

新增测试直接读取 `debug/reasoning-last/summary.json`，断言至少包含：

```ts
expect(summary).toEqual(
  expect.objectContaining({
    currentTime: expect.any(String),
    userQuery: expect.any(String),
    rounds: expect.any(Number),
    stoppedBecause: expect.any(String),
    finalAnchorIds: expect.any(Array),
    hasUnsatisfiedRequiredGoal: expect.any(Boolean),
  }),
);
```

- [ ] **Step 1.3: 写失败测试，锁定 `recall-rounds.json` 的最小 schema**

新增测试读取 `debug/reasoning-last/recall-rounds.json`，断言每轮至少包含：

```ts
expect(round).toEqual(
  expect.objectContaining({
    round: expect.any(Number),
    query: expect.any(String),
    newAnchorIds: expect.any(Array),
    allAnchorIds: expect.any(Array),
    normalizedGoalStatus: expect.any(Array),
  }),
);
```

若某轮有停止候选，再断言 `stoppedCandidate` 为字符串。

- [ ] **Step 1.5: 补 writer 级文件系统测试，锁定“已存在目标目录时仍整体 replace”**

如果 engine 测试不便精确锁文件系统语义，则新建一个小型 writer 测试（可并入 `engine.test.ts`，也可后续抽成独立测试文件），至少验证：

- 先准备一份旧的 `debug/reasoning-last/`
- 再写入新 artifact
- 最终目录只包含新文件集
- 写入过程经过 tmp dir + replace，而不是逐文件覆盖
- 外部读取入口始终保持为 `debug/reasoning-last/`；symlink 只作为内部原子切换手段，不改变调试者的读取路径

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: FAIL

- [ ] **Step 3: 创建 writer 模块**

在 `packages/server/src/reasoning/debug-artifact.ts` 实现：

```ts
export type ReasoningDebugArtifact = {
  request: unknown;
  decomposition: unknown;
  recallRounds: unknown;
  finalPrompt: string;
  response: string;
  summary: unknown;
};

export async function writeLatestReasoningArtifact(...): Promise<void>
```

写入策略：

- 先写版本化目录，例如 `debug/.reasoning-artifacts/<requestId>/`
- 再生成一个临时 symlink，例如 `debug/.reasoning-last-link-<requestId>`，指向该版本化目录
- 最后用单次 `rename()` 原子替换 `debug/reasoning-last` 这个 symlink 指针
- 旧版本目录可在成功切换后异步清理；不要先删除 `debug/reasoning-last`
- 目录不存在时自动创建

- [ ] **Step 4: 在 engine 中接入 writer，但默认受开关控制**

给 engine deps 增加可选配置，例如：

```ts
debugArtifacts?: {
  enabled: boolean;
  rootDir: string;
}
```

只在 `enabled === true` 时写入，默认测试显式开启，避免对所有环境默认落盘。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: PASS

### Task 8: 让路由层可注入 debug artifact 配置

**Files:**

- Modify: `packages/server/src/routes/reasoning.ts`
- Test: `packages/server/test/reasoning/engine.test.ts`

- [ ] **Step 1: 写失败测试，要求 createEngine 可传入 debugArtifacts 配置**

如果 route 内部函数不便直接测试，先把 `createEngine` 抽到可导入的小 factory（例如 `packages/server/src/reasoning/create-engine.ts`），再为该 factory 写测试。目标是锁定“调试落盘不默认开启，需要显式配置”，不要在超长 route 文件里硬测私有内部函数。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: FAIL

- [ ] **Step 3: 最小接入配置**

在 `createEngine()` 附近把 `debugArtifacts` 配置从 route 层传进 `ReasoningEngine`。如果当前还没有统一 config 层，先在 route 创建处做最小静态注入，不在本任务里扩展全局配置系统。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: PASS

---

## Chunk 5: 最终验证

### Task 9: 跑目标测试并收敛回归

**Files:**

- Test: `packages/server/test/recall/goal-based-recall.test.ts`
- Test: `packages/server/test/reasoning/prompts.test.ts`
- Test: `packages/server/test/reasoning/engine.test.ts`
- Test: `packages/server/test/interview/engine.test.ts`
- Test: `packages/server/test/avatar/runtime.test.ts`

- [ ] **Step 1: 运行 recall 单测**

Run: `npx vitest run packages/server/test/recall/goal-based-recall.test.ts`
Expected: PASS

- [ ] **Step 2: 运行 prompts 单测**

Run: `npx vitest run packages/server/test/reasoning/prompts.test.ts`
Expected: PASS

- [ ] **Step 3: 运行 engine 单测**

Run: `npx vitest run packages/server/test/reasoning/engine.test.ts`
Expected: PASS

- [ ] **Step 4: 运行 reasoning 相关测试集合**

Run: `npx vitest run packages/server/test/recall/goal-based-recall.test.ts packages/server/test/reasoning/prompts.test.ts packages/server/test/reasoning/engine.test.ts packages/server/test/interview/engine.test.ts packages/server/test/avatar/runtime.test.ts`
Expected: PASS

- [ ] **Step 5: 记录响应时间风险观察点**

在实现说明或提交说明里记录本轮新增的额外调用成本：

- decomposition 增加 1 次 chat 调用
- recall-loop 在复杂场景仍会多轮
- full-injection 继续保留阈值短路，作为首层性能护栏

如果测试环境方便，再补一条 smoke 日志对比，不在本计划里强制引入基准测试框架。
