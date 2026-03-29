# Reasoning Gap Probe Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `AvatarInferenceRuntime` synthesize non-blocking reasoning gap probe candidates, normalize their questions with a shared canonicalization path, and write them into the approval candidate queue without blocking the current answer.

**Architecture:** Keep answer generation as the primary path inside `AvatarInferenceRuntime`, then run probe creation as a detached best-effort side effect after the answer result is already formed. Extract the question-normalization contract from the existing interview extraction rules into a shared reasoning/interview module, keep runtime state in reasoning-domain types instead of approval DTOs, and wire approval-backed candidate creation into both platform reasoning and OpenAI-compatible runtime entrypoints behind an owner allowlist.

**Tech Stack:** TypeScript, Vitest, Hono, Drizzle, existing approval service, existing reasoning runtime/prompt pipeline.

---

## Executive Summary

- 在 `AvatarInferenceRuntime` 中新增 reasoning gap probe synthesis，但 probe 只作为回答完成后的 detached side effect。
- 共享现有 interview question 规范，抽出 `displayQuestion` / `canonicalQuestion` 统一入口，避免 reasoning/interview 漂移。
- request 内做 exact `canonicalQuestion` 去重，并在本轮 recalled answered anchor 命中时丢弃 probe；不做更重的跨请求/跨库 dedupe。
- runtime 只保留 reasoning-domain `PendingReasoningProbe`，由 route 层适配成 `approvalService.createCandidate(...)`。
- `reasoning route` 与 `/ai/v1/chat/completions` 都接入 reasoning probe writer，但默认关闭，仅对 allowlisted owner 打开。
- 观测以结构化日志为最小实现：记录每请求 probe 数、drop 数、create 成功/失败数、latency delta。
- 回滚方式是关闭 `REMI_REASONING_GAP_PROBE_OWNERS`，停止新增 `source: reasoning` candidates；已落库候选保留，不做清理脚本。
- 验收重点：non-stream 不等待 flush 返回、stream 首 token 不等待 flush、取消前不创建 probe、补成 answered anchor 后能经现有 recall 受益。

## Alternatives

### 方案 A：只在 `reasoning route` 落地，不覆盖 OpenAI-compatible route

不选原因：同一 runtime 会再次分叉成两条能力面；后续 reasoning probe 行为会在产品内路由与 OpenAI-compatible 路由之间漂移。

### 方案 B：同步写入 approval candidate，再返回回答

不选原因：直接违反 spec 的非阻塞约束；一旦 approval 写入慢或失败，会污染回答主链延迟与错误语义。

### 方案 C：runtime 内直接持有 approval DTO 并自行落库

不选原因：会把 reasoning-domain state 与 approval 写模型绑定在一起，后续难以维护边界，也不利于测试 detached flush contract。

## Migration / Rollout / Rollback

- 默认关闭：未配置 `REMI_REASONING_GAP_PROBE_OWNERS` 时，所有 route 都不创建 reasoning probes。
- rollout：先只给少量 owner 加 allowlist，再观察 `reasoning_probe_generated` 摘要日志中的 `probeCount`、`createSuccessCount`、`createFailureCount`、`latencyDeltaMs`。
- rollout 期间只允许新增 `source: reasoning` candidates，不修改已有 approval / anchor 数据语义。
- rollback：清空或关闭 `REMI_REASONING_GAP_PROBE_OWNERS`，停止新增 reasoning probes。
- rollback 后不清理已创建的 `source: reasoning` candidates；保留历史数据，避免回滚引入额外破坏性操作。
- 若 rollout 期间发现 `latencyDeltaMs` 或 `createFailureCount` 持续异常，则先关 allowlist，再根据日志决定是否继续排查 prompt / route / approval 写入链路。

## File Structure

- Modify: `packages/server/src/types.ts`
  - Add `reasoning` as a valid `SoulAnchorSource`.
- Create: `packages/server/src/reasoning/question-canonicalization.ts`
  - Shared question contract for `displayQuestion` / `canonicalQuestion` plus light post-processing.
- Modify: `packages/server/src/interview/prompts.ts`
  - Import shared question rules instead of duplicating probe/interview wording drift.
- Modify: `packages/server/src/interview/extractor.ts`
  - Reuse the shared post-processing helper instead of keeping a private normalization path.
- Modify: `packages/server/src/reasoning/prompts.ts`
  - Add structured gap-probe synthesis prompt builder and shared question-rule injection.
- Create: `packages/server/src/reasoning/gap-probes.ts`
  - Convert recall/judgment state into normalized probe drafts, apply request-local guards, and expose reasoning-domain probe payloads.
- Modify: `packages/server/src/avatar/model.ts`
  - Add runtime-side reasoning probe payload types if needed for prepared metadata/request bookkeeping.
- Modify: `packages/server/src/avatar/runtime.ts`
  - Prepare reasoning probes during `createRequest`, keep them off the answer path, and expose detached flush hooks for stream/non-stream.
- Modify: `packages/server/src/config/feature-flags.ts`
  - Add owner allowlist parsing for reasoning gap probes.
- Modify: `packages/server/src/routes/reasoning.ts`
  - Pass a reasoning-domain probe writer into runtime, adapt it to approval candidate creation, preserve stream cancel semantics, and gate it with owner allowlist.
- Modify: `packages/server/src/routes/ai-chat-completions.ts`
  - Pass the same reasoning-domain probe writer into runtime for OpenAI-compatible calls and gate it with owner allowlist.
- Modify: `packages/server/src/approval/service.ts`
  - No behavior change beyond accepting `source: "reasoning"`; keep shared normalization path.
- Test: `packages/server/test/reasoning/question-canonicalization.test.ts`
  - Lock the shared question contract and interview/reasoning parity.
- Test: `packages/server/test/reasoning/gap-probes.test.ts`
  - Verify allowed probe classes, banned outputs, request-local exact dedupe, and recalled answered-anchor guard.
- Test: `packages/server/test/avatar/runtime.test.ts`
  - Verify probe preparation, detached flushing, and non-blocking behavior.
- Test: `packages/server/test/routes/reasoning.test.ts`
  - Verify reasoning route writes `source: "reasoning"` candidates and respects allowlist/logging.
- Test: `packages/server/test/routes/reasoning.transport.test.ts`
  - Verify SSE first-token / cancel semantics stay non-blocking while probes are enabled.
- Test: `packages/server/test/routes/ai-chat-completions.test.ts`
  - Verify OpenAI-compatible route also creates reasoning probes, respects allowlist, and preserves response semantics.
- Test: `packages/server/test/approval/service.test.ts`
  - Extend source coverage to include `reasoning`.

## Chunk 1: Shared Question Canonicalization

完成定义：共享 question canonicalization 能同时服务 interview 和 reasoning，且 approval 已接受 `source: reasoning`。

### Task 1: Extend source types and lock approval acceptance

**Files:**

- Modify: `packages/server/src/types.ts`
- Test: `packages/server/test/approval/service.test.ts`

- [ ] **Step 1: Write the failing source-acceptance test**

```ts
it("accepts reasoning as a candidate source", () => {
  const created = service.createCandidate({
    question: "我在做这类决定时还缺什么判断标准？",
    answer: null,
    source: "reasoning",
  });

  expect(created.source).toBe("reasoning");
  expect(created.kind).toBe("probe");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/server/test/approval/service.test.ts -t "accepts reasoning as a candidate source"`
Expected: FAIL with a TypeScript/source mismatch because `reasoning` is not in `SoulAnchorSource`.

- [ ] **Step 3: Add the minimal source type change**

```ts
export type SoulAnchorSource = "interview" | "manual" | "reading" | "reasoning";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/server/test/approval/service.test.ts -t "accepts reasoning as a candidate source"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/types.ts packages/server/test/approval/service.test.ts
git commit -m "feat(server): allow reasoning probe candidate source"
```

### Task 2: Extract a shared question canonicalization contract

**Files:**

- Create: `packages/server/src/reasoning/question-canonicalization.ts`
- Modify: `packages/server/src/interview/prompts.ts`
- Modify: `packages/server/src/interview/extractor.ts`
- Test: `packages/server/test/reasoning/question-canonicalization.test.ts`
- Test: `packages/server/test/interview/prompts.test.ts`
- Test: `packages/server/test/interview/extractor.test.ts`

- [ ] **Step 1: Write the failing shared canonicalization tests**

```ts
it("returns displayQuestion and canonicalQuestion from the same draft", () => {
  const result = canonicalizeQuestionDraft({
    draft: "用户刚才提到的那个项目里最重要的是什么？",
    ownerVoice: "first-person",
  });

  expect(result.displayQuestion).toContain("我");
  expect(result.canonicalQuestion).toBe("我提到的项目里最重要的是什么？");
});

it("keeps interview and reasoning canonicalQuestion aligned", () => {
  const interview = canonicalizeQuestionDraft({
    draft: "用户的决策偏好是什么样的？",
    ownerVoice: "first-person",
  });
  const reasoning = canonicalizeQuestionDraft({
    draft: "用户的决策偏好是什么样的？",
    ownerVoice: "first-person",
  });

  expect(interview.canonicalQuestion).toBe(reasoning.canonicalQuestion);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- packages/server/test/reasoning/question-canonicalization.test.ts packages/server/test/interview/extractor.test.ts packages/server/test/interview/prompts.test.ts`
Expected: FAIL because the shared module does not exist and interview still uses a private normalization path.

- [ ] **Step 3: Implement the shared question contract**

```ts
export interface CanonicalizedQuestion {
  displayQuestion: string;
  canonicalQuestion: string;
}

export function canonicalizeQuestionDraft(input: {
  draft: string;
  ownerVoice: "first-person";
}): CanonicalizedQuestion {
  const displayQuestion = normalizeOwnerQuestionDraft(input.draft);
  return {
    displayQuestion,
    canonicalQuestion: collapseQuestionForExactMatch(displayQuestion),
  };
}
```

- [ ] **Step 4: Repoint interview modules at the shared helper**

```ts
const normalized = canonicalizeQuestionDraft({ draft: item.question, ownerVoice: "first-person" });
return { question: normalized.displayQuestion, answer: item.answer.trim() };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- packages/server/test/reasoning/question-canonicalization.test.ts packages/server/test/interview/extractor.test.ts packages/server/test/interview/prompts.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/reasoning/question-canonicalization.ts packages/server/src/interview/prompts.ts packages/server/src/interview/extractor.ts packages/server/test/reasoning/question-canonicalization.test.ts packages/server/test/interview/prompts.test.ts packages/server/test/interview/extractor.test.ts
git commit -m "refactor(server): share question canonicalization rules"
```

## Chunk 2: Probe Synthesis and Runtime Contracts

完成定义：runtime 能准备 request-local reasoning probes，并以 detached best-effort 方式在回答完成后触发 flush。

### Task 3: Add structured gap-probe synthesis with request-local guards

**Files:**

- Create: `packages/server/src/reasoning/gap-probes.ts`
- Modify: `packages/server/src/reasoning/prompts.ts`
- Test: `packages/server/test/reasoning/gap-probes.test.ts`

- [ ] **Step 1: Write the failing probe-synthesis tests**

```ts
it("creates up to three high-value probe drafts from missing goals", async () => {
  const probes = await synthesizeGapProbes({
    userQuery: "她适合找我聊这件事吗？",
    goalStatus: [
      {
        goalId: "relationship_boundary",
        sufficient: false,
        known: [],
        missing: ["我和对方现在是什么关系", "我通常在这种关系里怎么设边界"],
        knownAnchorIds: [],
        missingKeys: ["relationship-status", "boundary-style"],
      },
    ],
    recalledAnchors: [],
  });

  expect(probes).toHaveLength(2);
});

it("drops a probe when the same canonical question is already answered in recalled anchors", async () => {
  const probes = await synthesizeGapProbes({
    userQuery: "我该怎么回复？",
    goalStatus: [...],
    recalledAnchors: [{ id: "a1", question: "我在这种关系里怎么设边界？", answer: "...", source: "interview", createdAt: 1, updatedAt: 1 }],
  });

  expect(probes).toEqual([]);
});

it("keeps the probe when the recalled match is still unanswered", async () => {
  const probes = await synthesizeGapProbes({
    userQuery: "我该怎么回复？",
    goalStatus: [...],
    recalledAnchors: [{ id: "a2", question: "我在这种关系里怎么设边界？", answer: null, source: "reading", createdAt: 1, updatedAt: 1 }],
  });

  expect(probes).toHaveLength(1);
});

it("creates only one probe when two drafts collapse to the same canonicalQuestion", async () => {
  const probes = await synthesizeGapProbes({ ...inputWithDuplicateDrafts });
  expect(probes).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/server/test/reasoning/gap-probes.test.ts`
Expected: FAIL because the synthesis module and prompt contract do not exist.

- [ ] **Step 3: Add the prompt builder and synthesis module**

```ts
export interface PendingReasoningProbe {
  displayQuestion: string;
  canonicalQuestion: string;
  kind: "fact-gap" | "judgment-gap" | "term-gap";
  sourceRef?: string | null;
  sourceSnapshot?: Record<string, unknown> | null;
}

export async function synthesizeGapProbes(input: SynthesisInput): Promise<PendingReasoningProbe[]> {
  const rawDrafts = await generateProbeDraftsFromPrompt(input);
  const canonicalized = rawDrafts.map((draft) =>
    canonicalizeQuestionDraft({ draft, ownerVoice: "first-person" }),
  );
  return dedupeWithinRequestAndFilterRecalledAnswers(canonicalized, input.recalledAnchors).slice(
    0,
    3,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/server/test/reasoning/gap-probes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/reasoning/prompts.ts packages/server/src/reasoning/gap-probes.ts packages/server/test/reasoning/gap-probes.test.ts
git commit -m "feat(server): synthesize reasoning gap probe drafts"
```

### Task 4: Prepare reasoning-domain probes inside runtime

**Files:**

- Modify: `packages/server/src/avatar/model.ts`
- Modify: `packages/server/src/avatar/runtime.ts`
- Test: `packages/server/test/avatar/runtime.test.ts`

- [ ] **Step 1: Write the failing runtime preparation tests**

```ts
it("stores pending reasoning probes as runtime metadata instead of approval DTOs", async () => {
  const request = await runtime.createRequest({ ...input, stream: false });
  const metadata = runtime.getPreparedReasoningProbeMetadata(request);

  expect(metadata?.pendingReasoningProbes).toEqual([
    expect.objectContaining({ canonicalQuestion: expect.any(String) }),
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/server/test/avatar/runtime.test.ts -t "pending reasoning probes"`
Expected: FAIL because runtime does not expose reasoning probe metadata.

- [ ] **Step 3: Add minimal reasoning-domain runtime types**

```ts
type PreparedInference = RuntimeDebugState & {
  request: AvatarInferenceRequest;
  thinkingNarratives: string[];
  pendingReasoningProbes: PendingReasoningProbe[];
};
```

- [ ] **Step 4: Populate pending probes during `createRequest`**

```ts
const pendingReasoningProbes = await synthesizeGapProbes({
  userQuery: decomposition.userQuery,
  goalStatus: recall.goalStatus,
  recalledAnchors: recall.anchors,
  ...
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- packages/server/test/avatar/runtime.test.ts -t "pending reasoning probes"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/avatar/model.ts packages/server/src/avatar/runtime.ts packages/server/test/avatar/runtime.test.ts
git commit -m "feat(server): prepare reasoning-domain probe payloads"
```

### Task 5: Enforce detached flush semantics for stream and non-stream

**Files:**

- Modify: `packages/server/src/avatar/runtime.ts`
- Test: `packages/server/test/avatar/runtime.test.ts`

- [ ] **Step 1: Write the failing detached-flush tests**

```ts
it("does not wait for probe flushing before returning a non-stream response", async () => {
  let resolveFlush: (() => void) | undefined;
  const flushReasoningProbes = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveFlush = resolve;
      }),
  );
  const runtime = new AvatarInferenceRuntime({ ...deps, flushReasoningProbes });

  const request = await runtime.createRequest({ ...input, stream: false });
  const response = await runtime.run(request);

  expect(response.finishReason).toBe("stop");
  expect(flushReasoningProbes).toHaveBeenCalledTimes(1);
  resolveFlush?.();
});

it("does not wait for probe flushing before the first stream token", async () => {
  const flushReasoningProbes = vi.fn(() => new Promise(() => {}));
  const runtime = new AvatarInferenceRuntime({ ...deps, flushReasoningProbes });

  const request = await runtime.createRequest({ ...input, stream: true });
  const stream = runtime.runStream(request);
  const first = await stream.next();

  expect(first.value).toEqual({ type: "message_start", message: { role: "assistant" } });
});

it("does not change the response when detached probe flushing fails", async () => {
  const flushReasoningProbes = vi.fn().mockRejectedValue(new Error("probe write failed"));
  const runtime = new AvatarInferenceRuntime({ ...deps, flushReasoningProbes });

  const request = await runtime.createRequest({ ...input, stream: false });
  const response = await runtime.run(request);

  expect(response.finishReason).toBe("stop");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/server/test/avatar/runtime.test.ts -t "probe flushing"`
Expected: FAIL because runtime still has no detached flush contract.

- [ ] **Step 3: Add the runtime-side detached flush hook**

```ts
interface AvatarInferenceRuntimeDeps {
  ...
  flushReasoningProbes?: (probes: PendingReasoningProbe[]) => Promise<void> | void;
}

private flushReasoningProbesBestEffort(request: AvatarInferenceRequest): void {
  const prepared = this.preparedInferenceByRequest.get(request);
  if (!prepared || !this.deps.flushReasoningProbes || prepared.pendingReasoningProbes.length === 0) {
    return;
  }
  void Promise.resolve(this.deps.flushReasoningProbes(prepared.pendingReasoningProbes)).catch(() => {
    // best-effort only
  });
}
```

- [ ] **Step 4: Call the flush hook only after the answer object/event sequence is already formed**

```ts
// run()
const response = await this.deps.chatClient.chat(...);
const result = { message: ..., finishReason: ..., usage: ... };
this.flushReasoningProbesBestEffort(request);
return result;

// runStream()
yield { type: "message_start", ... };
...
yield { type: "message_end", finishReason: "stop" };
this.flushReasoningProbesBestEffort(request);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- packages/server/test/avatar/runtime.test.ts -t "probe flushing"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/avatar/runtime.ts packages/server/test/avatar/runtime.test.ts
git commit -m "feat(server): detach reasoning probe flush from answer path"
```

## Chunk 3: Route Wiring, Allowlist, and Verification

完成定义：两条 route 都能在 allowlist 打开时创建 reasoning probes，并具备最小 rollout / rollback / observability / cancel 验证能力。

### Task 6: Wire reasoning and chat-completions routes through approval-backed probe writers

**Files:**

- Modify: `packages/server/src/routes/reasoning.ts`
- Modify: `packages/server/src/routes/ai-chat-completions.ts`
- Test: `packages/server/test/routes/reasoning.test.ts`
- Test: `packages/server/test/routes/ai-chat-completions.test.ts`

- [ ] **Step 1: Write the failing route wiring tests**

```ts
it("creates reasoning probe candidates for the reasoning route", async () => {
  expect(findEvents(records, "candidate_created")[0]).toEqual(
    expect.objectContaining({ source: "reasoning" }),
  );
});

it("creates reasoning probe candidates for chat completions without changing the response schema", async () => {
  expect(findEvents(records, "candidate_created")[0]).toEqual(
    expect.objectContaining({ source: "reasoning" }),
  );
  expect(json.object).toBe("chat.completion");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- packages/server/test/routes/reasoning.test.ts packages/server/test/routes/ai-chat-completions.test.ts`
Expected: FAIL because neither route passes a probe writer into runtime.

- [ ] **Step 3: Adapt reasoning-domain probes into approval candidate writes**

```ts
const approvalService = createApprovalService({
  ownerKey,
  conn: ownerConn,
  embeddingClient: deps.embeddingClient,
});
const flushReasoningProbes = async (probes: PendingReasoningProbe[]) => {
  for (const probe of probes) {
    approvalService.createCandidate({
      question: probe.displayQuestion,
      answer: null,
      source: "reasoning",
      sourceRef: probe.sourceRef ?? null,
      sourceSnapshot: probe.sourceSnapshot ?? null,
    });
  }
};
```

- [ ] **Step 4: Inject that writer into both routes**

```ts
const runtime = new AvatarInferenceRuntime({
  ownerConn,
  chatClient: deps.chatClient,
  embeddingClient: deps.embeddingClient,
  flushReasoningProbes,
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- packages/server/test/routes/reasoning.test.ts packages/server/test/routes/ai-chat-completions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routes/reasoning.ts packages/server/src/routes/ai-chat-completions.ts packages/server/test/routes/reasoning.test.ts packages/server/test/routes/ai-chat-completions.test.ts
git commit -m "feat(server): wire runtime probes into approval routes"
```

### Task 7: Add owner allowlist, observability hooks, and cancel-path verification

**Files:**

- Modify: `packages/server/src/config/feature-flags.ts`
- Modify: `packages/server/src/avatar/runtime.ts`
- Modify: `packages/server/src/routes/reasoning.ts`
- Modify: `packages/server/src/routes/ai-chat-completions.ts`
- Modify: `packages/server/src/logger.ts`
- Test: `packages/server/test/routes/reasoning.test.ts`
- Test: `packages/server/test/routes/reasoning.transport.test.ts`
- Test: `packages/server/test/routes/ai-chat-completions.test.ts`

- [ ] **Step 1: Write the failing allowlist and observability tests**

```ts
it("enables reasoning probes only for allowlisted owners", () => {
  process.env.REMI_REASONING_GAP_PROBE_OWNERS = "owner-a,owner-b";
  expect(isReasoningGapProbeEnabledForOwner("owner-a")).toBe(true);
  expect(isReasoningGapProbeEnabledForOwner("owner-c")).toBe(false);
});

it("does not create reasoning probes when the owner is not allowlisted", async () => {
  expect(findEvents(records, "candidate_created")).toEqual([]);
});

it("records reasoning probe lifecycle events", async () => {
  expect(findEvents(records, "reasoning_probe_generated")).toHaveLength(1);
  expect(findEvents(records, "reasoning_probe_candidate_created")).toHaveLength(1);
  expect(findEvents(records, "reasoning_probe_generated")[0]).toEqual(
    expect.objectContaining({
      ownerKey: expect.any(String),
      requestId: expect.any(String),
      streamMode: "stream",
      probeCount: 1,
      droppedCount: 0,
    }),
  );
});
```

- [ ] **Step 2: Write the failing cancel/transport tests in the existing transport harness**

```ts
it("does not wait for probe flushing before the transport response is established", async () => {
  const flushStarted = createDeferred<void>();
  const flushFinished = createDeferred<void>();
  vi.spyOn(AvatarInferenceRuntime.prototype, "runStream").mockImplementation(async function* () {
    yield { type: "message_start", message: { role: "assistant" } };
    await flushStarted.promise;
    yield { type: "message_end", finishReason: "stop" };
  });
  const flushSpy = vi
    .spyOn(
      AvatarInferenceRuntime.prototype as AvatarInferenceRuntime & Record<string, unknown>,
      "flushReasoningProbesBestEffort",
    )
    .mockImplementation(() => {
      flushStarted.resolve();
      return void flushFinished.promise;
    });

  const res = await app.request(`/api/${ownerPubKey}/reasoning/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "你好" }),
  });

  expect(res.status).toBe(200);
  expect(flushSpy).toHaveBeenCalled();
  flushFinished.resolve();
});

it("does not create reasoning probes when the stream is cancelled before the first token", async () => {
  const heartbeatFailure = createDeferred<never>();
  let notifyHeartbeatError: ((error: unknown) => void) | undefined;
  vi.doMock("../../src/lib/sse-heartbeat.js", () => ({
    createSseHeartbeat: (options: { onError?: (error: unknown) => void }) => {
      notifyHeartbeatError = options.onError;
      return {
        start() {},
        stop() {},
        recordRealWrite() {},
        failure: heartbeatFailure.promise,
      };
    },
  }));

  const flushSpy = vi.spyOn(
    AvatarInferenceRuntime.prototype as AvatarInferenceRuntime & Record<string, unknown>,
    "flushReasoningProbesBestEffort",
  );
  vi.spyOn(AvatarInferenceRuntime.prototype, "runStream").mockImplementation(async function* () {
    const transportFailure = new Error("heartbeat write failed before first token");
    notifyHeartbeatError?.(transportFailure);
    heartbeatFailure.reject(transportFailure);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return;
  });

  const res = await app.request(`/api/${ownerPubKey}/reasoning/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "你好" }),
  });

  expect(res.status).toBe(200);
  expect(flushSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- packages/server/test/routes/reasoning.test.ts packages/server/test/routes/reasoning.transport.test.ts packages/server/test/routes/ai-chat-completions.test.ts`
Expected: FAIL because there is no allowlist helper, no structured reasoning-probe lifecycle logging with aggregatable fields, and no route-level gating on transport/cancel paths.

- [ ] **Step 4: Implement the minimal allowlist helper**

```ts
export function isReasoningGapProbeEnabledForOwner(ownerKey: string): boolean {
  const raw = process.env.REMI_REASONING_GAP_PROBE_OWNERS?.trim();
  if (!raw) return false;
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  ).has(ownerKey);
}
```

- [ ] **Step 5: Gate both routes and add the minimal lifecycle logs**

```ts
const enabled = isReasoningGapProbeEnabledForOwner(ownerKey);
if (!enabled) {
  return undefined;
}

log.info({
  event: "reasoning_probe_generated",
  ownerKey,
  requestId,
  streamMode,
  probeCount,
  droppedCount,
  createSuccessCount,
  createFailureCount,
  latencyDeltaMs,
});

log.info({
  event: "reasoning_probe_candidate_created",
  ownerKey,
  requestId,
  streamMode,
  candidateId,
});
log.warn({
  event: "reasoning_probe_candidate_create_failed",
  ownerKey,
  requestId,
  streamMode,
  err,
});
```

- [ ] **Step 6: Derive the four promised observability signals from structured log fields**

```ts
// single emitted summary record per request
{
  event: "reasoning_probe_generated",
  ownerKey,
  requestId,
  streamMode,
  probeCount,
  droppedCount,
  createSuccessCount,
  createFailureCount,
  latencyDeltaMs,
}
```

This single summary record is the MVP observability outlet for:

- `probe_per_request` -> `probeCount`
- `probe_candidate_create_success_rate` -> `createSuccessCount / (createSuccessCount + createFailureCount)`
- `probe_drop_rate` -> `droppedCount / (probeCount + droppedCount)`
- `reasoning_latency_delta_ms` -> `latencyDeltaMs`

- [ ] **Step 7: Run targeted tests to verify they pass**

Run: `npm test -- packages/server/test/routes/reasoning.test.ts packages/server/test/routes/reasoning.transport.test.ts packages/server/test/routes/ai-chat-completions.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full server test slice**

Run: `npm test -- packages/server/test/reasoning/question-canonicalization.test.ts packages/server/test/reasoning/gap-probes.test.ts packages/server/test/avatar/runtime.test.ts packages/server/test/routes/reasoning.test.ts packages/server/test/routes/reasoning.transport.test.ts packages/server/test/routes/ai-chat-completions.test.ts packages/server/test/approval/service.test.ts packages/server/test/interview/prompts.test.ts packages/server/test/interview/extractor.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/config/feature-flags.ts packages/server/src/avatar/runtime.ts packages/server/src/routes/reasoning.ts packages/server/src/routes/ai-chat-completions.ts packages/server/src/logger.ts packages/server/test/routes/reasoning.test.ts packages/server/test/routes/reasoning.transport.test.ts packages/server/test/routes/ai-chat-completions.test.ts
git commit -m "feat(server): gate and observe reasoning gap probes"
```
