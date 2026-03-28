# Reasoning Runtime Unification Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse `ReasoningEngine` into `AvatarInferenceRuntime`, route both `/:pubKey/reasoning/message` and `/ai/v1/chat/completions` through the same inference core, preserve the existing downstream message skeleton, and upgrade debug artifacts to expose turn-by-turn LLM inputs/outputs plus final messages.

**Architecture:** Keep the current `AvatarInferenceRuntime` message skeleton (`system = platform + avatar + caller system`, caller messages, recall tail) and move the stronger reasoning orchestration from `packages/server/src/reasoning/engine.ts` into runtime-owned modules. `packages/server/src/routes/reasoning.ts` becomes a conversation adapter that reads/stores direct messages and maps them into caller messages, while `/ai/v1/chat/completions` remains a protocol adapter. Debug output shifts from a single final prompt dump to a unified runtime trace with per-turn prompt/response files and a readable `final-prompt.md` generated from the actual downstream `messages` array.

**Tech Stack:** TypeScript, Hono, Vitest, existing avatar/runtime/recall infrastructure, file-based debug artifacts

---

## File Map

### Runtime core

- Modify: `packages/server/src/avatar/runtime.ts`
  - Become the only inference orchestrator.
  - Absorb decomposition, default/temporal goal logic, sufficiency handling, missing-info collection, debug artifact hooks, and final generation orchestration.
- Modify: `packages/server/src/avatar/model.ts`
  - Extend the runtime request/result model only where needed for shared conversation + debug metadata.
- Modify: `packages/server/src/avatar/message-augmentation.ts`
  - Keep the existing downstream message order, but add helpers for caller-system supplements, richer recall tail formatting, and readable message rendering for artifacts.

### Shared reasoning modules

- Modify: `packages/server/src/reasoning/prompts.ts`
  - Keep reusable decomposition/judgment builders.
  - Replace the old single-string generation prompt dependency with runtime-friendly helpers for recall-tail content and per-turn serialization.
- Modify: `packages/server/src/reasoning/debug-artifact.ts`
  - Upgrade from single final prompt dumps to unified turn-based prompt/response dumps plus final message artifacts.
- Delete at the end: `packages/server/src/reasoning/engine.ts`
  - Only after all callers and tests are migrated.

### Adapters and routes

- Modify: `packages/server/src/routes/ai-chat-completions.ts`
  - Continue to parse OpenAI requests, but call the upgraded unified runtime.
- Modify: `packages/server/src/routes/reasoning.ts`
  - Replace `ReasoningEngine` construction with conversation-history -> runtime request mapping and existing message persistence/receipt flows.

### Tests

- Modify: `packages/server/test/avatar/runtime.test.ts`
  - Add runtime orchestration coverage previously only present in `ReasoningEngine` tests.
- Modify: `test/avatar-openapi-integration.test.ts`
  - Keep adapter + ordering guarantees while validating the stronger runtime behavior.
- Modify: `packages/server/test/routes/reasoning.test.ts`
  - Preserve route contract while ensuring it uses unified runtime semantics.
- Replace/delete at the end: `packages/server/test/reasoning/engine.test.ts`
  - Migrate assertions into runtime/route/debug-artifact tests before removing.

### Docs / state tracking

- Modify: `.legion/context.md`
- Modify: `.legion/tasks.md`

## Chunk 1: Move Reasoning Orchestration Into AvatarInferenceRuntime

### Task 1: Port decomposition and sufficiency orchestration into runtime tests first

**Files:**

- Modify: `packages/server/test/avatar/runtime.test.ts`
- Reference: `packages/server/test/reasoning/engine.test.ts`
- Reference: `packages/server/src/avatar/runtime.ts`

- [ ] **Step 1: Add failing runtime tests for decomposition fallback and temporal-goal enforcement**

Add tests that mirror the old `ReasoningEngine` expectations, for example:

```ts
it("falls back to default goals when decomposition JSON is invalid", async () => {
  chatClient.chat
    .mockResolvedValueOnce(createChatResponse("not-json"))
    .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()));

  await runtime.createRequest({
    avatarTarget: { publicKey: "owner-pubkey" },
    conversationTurns: [{ role: "user", content: "我最近怎么样？" }],
    stream: false,
  });

  expect(chatClient.chat.mock.calls[1][0].messages[1].content).toContain("temporal_validity");
});
```

- [ ] **Step 2: Run the focused runtime test file and verify the new cases fail**

Run: `npx vitest run packages/server/test/avatar/runtime.test.ts`

Expected: FAIL because `AvatarInferenceRuntime` does not yet perform decomposition/sufficiency orchestration.

- [ ] **Step 3: Expand runtime dependencies and internal helpers to own the reasoning flow**

In `packages/server/src/avatar/runtime.ts`, introduce engine-owned helpers ported from `ReasoningEngine`, including shapes like:

```ts
type ParsedDecomposition = {
  userQuery: string;
  currentTime: string;
  answerGoals: ReasoningAnswerGoal[];
};

private buildDefaultAnswerGoals(content: string): ReasoningAnswerGoal[] {
  // identity_style / relationship_boundary / domain_answer
  // + temporal_validity for time-sensitive requests
}

private parseDecomposition(content: string, fallbackQuery: string, currentTime: string) {
  // engine-owned currentTime / userQuery
}
```

Also replace the current XML-style `parseRecallJudgment()` path with the structured JSON judgment parsing already proven in `ReasoningEngine`.

- [ ] **Step 4: Keep the downstream message skeleton unchanged while moving orchestration earlier**

Refactor `createRequest()` so it:

1. Reads owner profile.
2. Runs decomposition using `buildReasoningDecompositionPrompt(...)`.
3. Runs goal-based recall with `buildReasoningJudgmentPrompt(...)`.
4. Produces a richer recall tail string instead of the old bare anchor dump.
5. Returns the same `instructionSegments + conversationTurns` shape expected by `buildDownstreamMessages()`.

The resulting recall tail should carry evidence, missing information, sufficiency boundaries, and anchor timestamps, but remain an appended tail assistant message rather than replacing the downstream message array contract.

- [ ] **Step 5: Add tests for missing-info carry-through and no-reasoning-chain leakage on parse failure**

Port old coverage such as:

```ts
expect(request.instructionSegments.recall).toContain("缺少更近期更新");
expect(request.instructionSegments.recall).toContain("StoppedBecause: no-new-anchors");
expect(request.instructionSegments.recall).not.toContain("这条链路不该泄漏");
```

- [ ] **Step 6: Run runtime tests again and make them pass**

Run: `npx vitest run packages/server/test/avatar/runtime.test.ts`

Expected: PASS with the new orchestration assertions.

- [ ] **Step 7: Commit the runtime orchestration migration**

```bash
git add packages/server/src/avatar/runtime.ts packages/server/src/reasoning/prompts.ts packages/server/test/avatar/runtime.test.ts
git commit -m "refactor: move reasoning orchestration into avatar runtime"
```

### Task 2: Upgrade recall-tail construction without changing downstream message order

**Files:**

- Modify: `packages/server/src/avatar/message-augmentation.ts`
- Modify: `packages/server/src/reasoning/prompts.ts`
- Test: `packages/server/test/avatar/runtime.test.ts`
- Test: `test/avatar-openapi-integration.test.ts`

- [ ] **Step 1: Add failing tests for richer recall-tail content and stable ordering**

Add assertions that runtime/openapi calls still produce:

```ts
expect(recordedCalls[0]?.map((message) => message.role)).toEqual([
  "system",
  "assistant",
  "user",
  "assistant",
]);
expect(recordedCalls[0]?.[3]?.content).toContain("UpdatedAt:");
expect(recordedCalls[0]?.[3]?.content).toContain("Missing Information");
```

- [ ] **Step 2: Run the runtime + OpenAI integration tests and verify failures**

Run: `npx vitest run packages/server/test/avatar/runtime.test.ts test/avatar-openapi-integration.test.ts`

Expected: FAIL until the richer recall-tail builder is in place.

- [ ] **Step 3: Replace the old simple `buildRecallSegment()` with structured tail rendering helpers**

In `packages/server/src/avatar/message-augmentation.ts`, keep the last assistant-message slot but make its content render sections such as:

```ts
Supplementary recalled anchors (lower priority than platform, avatar, and caller context):

## Evidence
- Q: ...
  A: ...
  UpdatedAt: ...

## Missing Information
- ...

## Non-evidence Reasoning
- GoalId: ...
```

Do not reorder roles in `buildDownstreamMessages()`.

- [ ] **Step 4: Keep identity and caller-system work localized to runtime-friendly segments**

Add helpers for:

- owner public key / display name / bio in the avatar segment
- caller-system supplement text (if provided by the route/adapter later)
- readable final-message rendering support used by debug artifacts

Avoid introducing a new giant system prompt string API.

- [ ] **Step 5: Re-run the focused tests and make them pass**

Run: `npx vitest run packages/server/test/avatar/runtime.test.ts test/avatar-openapi-integration.test.ts`

Expected: PASS with ordering preserved and richer recall-tail content present.

- [ ] **Step 6: Commit the recall-tail/message-augmentation update**

```bash
git add packages/server/src/avatar/message-augmentation.ts packages/server/src/reasoning/prompts.ts packages/server/test/avatar/runtime.test.ts test/avatar-openapi-integration.test.ts
git commit -m "refactor: enrich runtime recall tail without changing message order"
```

## Chunk 2: Migrate Debug Artifacts and Shared Runtime Entry Points

### Task 3: Convert debug artifacts from single-prompt dumps into turn-based runtime traces

**Files:**

- Modify: `packages/server/src/reasoning/debug-artifact.ts`
- Modify: `packages/server/src/avatar/runtime.ts`
- Modify: `packages/server/test/avatar/runtime.test.ts`
- Reference: `packages/server/test/reasoning/engine.test.ts`

- [ ] **Step 1: Add failing runtime/debug tests for turn-based artifact output**

Create tests that expect files like:

```ts
expect((await readdir(latestDir)).sort()).toEqual([
  "01-decomposition-prompt.json",
  "01-decomposition-prompt.md",
  "01-decomposition-response.json",
  "01-decomposition-response.txt",
  "02-sufficiency-round-1-prompt.json",
  "02-sufficiency-round-1-prompt.md",
  "02-sufficiency-round-1-response.json",
  "02-sufficiency-round-1-response.txt",
  "03-final-generation-prompt.json",
  "03-final-generation-prompt.md",
  "03-final-generation-response.txt",
  "final-messages.json",
  "final-prompt.md",
  "response.txt",
  "summary.json",
]);
```

- [ ] **Step 2: Run the focused runtime tests and verify the new artifact assertions fail**

Run: `npx vitest run packages/server/test/avatar/runtime.test.ts`

Expected: FAIL because the current writer only knows the old `ReasoningEngine` artifact set.

- [ ] **Step 3: Redesign the artifact writer API around runtime turns**

Refactor `packages/server/src/reasoning/debug-artifact.ts` so the write contract can accept a sequence like:

```ts
type ReasoningDebugTurn = {
  turnId: string;
  promptMessages?: ChatMessage[];
  promptText?: string;
  responseText: string;
  responseJson?: unknown;
};
```

Add helpers to:

- render prompt messages to readable markdown using `[role: ...]`
- serialize raw prompt messages to JSON
- preserve the existing symlink/latest-directory safety guarantees

- [ ] **Step 4: Emit artifact turns from runtime orchestration points**

While runtime runs decomposition, each sufficiency round, and final generation, append trace items so the writer can output:

- `<turn-id>-prompt.md`
- `<turn-id>-prompt.json`
- `<turn-id>-response.txt`
- `<turn-id>-response.json` when applicable

Also emit:

- `final-messages.json`
- `final-prompt.md`
- `summary.json`
- `recall-rounds.json`

The final-generation step is not exempt from turn tracing. It must produce both the generic turn files:

- `03-final-generation-prompt.md`
- `03-final-generation-prompt.json`
- `03-final-generation-response.txt`

and the special final-output views:

- `final-messages.json`
- `final-prompt.md`

- [ ] **Step 5: Preserve the readable final downstream prompt format**

`final-prompt.md` must render the real downstream `messages` array like:

```md
[role: system]
...

[role: assistant]
...

[role: user]
...
```

Do not regress to a single raw JSON blob.

- [ ] **Step 6: Re-run runtime tests and make them pass**

Run: `npx vitest run packages/server/test/avatar/runtime.test.ts`

Expected: PASS with turn-level artifact output and preserved latest/symlink behavior.

- [ ] **Step 7: Commit the artifact migration**

```bash
git add packages/server/src/reasoning/debug-artifact.ts packages/server/src/avatar/runtime.ts packages/server/test/avatar/runtime.test.ts
git commit -m "refactor: trace unified runtime debug artifacts by llm turn"
```

### Task 4: Point the OpenAI adapter at the upgraded unified runtime behavior

**Files:**

- Modify: `packages/server/src/routes/ai-chat-completions.ts`
- Modify: `test/avatar-openapi-integration.test.ts`

- [ ] **Step 1: Add failing integration assertions for stronger runtime behavior through `/ai/v1/chat/completions`**

Examples:

```ts
expect(recording.recordedCalls[0]?.[0]?.content).toContain("Avatar identity:");
expect(recording.recordedCalls[0]?.[3]?.content).toContain("Missing Information");
expect(recording.recordedCalls[0]?.[3]?.content).toContain("UpdatedAt:");
```

- [ ] **Step 2: Run the OpenAI integration suite and verify failures if the adapter still misses runtime changes**

Run: `npx vitest run test/avatar-openapi-integration.test.ts`

Expected: one of exactly two outcomes:

- FAIL because the adapter is not yet threading newly required runtime inputs/outputs correctly
- PASS because the route is already thin enough and runtime changes were automatically inherited

- [ ] **Step 3: Take the deterministic branch based on Step 2**

- If Step 2 FAILS: patch `packages/server/src/routes/ai-chat-completions.ts` so it passes only the minimal new runtime inputs/options and re-run until PASS.
- If Step 2 PASSES: record in `.legion/context.md` that no adapter code change was required because the route remained a thin protocol adapter, then continue without modifying the file.

- [ ] **Step 4: Keep the adapter thin; only pass through new runtime options if needed**

If runtime now requires debug-root, caller supplement, or other request metadata, thread only those minimal fields through `ai-chat-completions.ts`. Do not move business logic into the route.

- [ ] **Step 5: Re-run OpenAI integration tests and ensure they pass**

Run: `npx vitest run test/avatar-openapi-integration.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the adapter alignment work**

```bash
git add packages/server/src/routes/ai-chat-completions.ts test/avatar-openapi-integration.test.ts
git commit -m "test: lock unified runtime behavior in openai adapter"
```

### Task 5: Lock stream-path parity in unified runtime before route cutover

**Files:**

- Modify: `packages/server/test/avatar/runtime.test.ts`
- Modify: `test/avatar-openapi-integration.test.ts`
- Modify: `packages/server/src/avatar/runtime.ts`

- [ ] **Step 1: Add failing tests that compare non-stream and stream behavior for the unified runtime path**

At minimum, assert that both paths:

- consume the same final downstream `messages`
- use the same recall/decomposition/sufficiency orchestration
- produce the same recalled-anchor metadata and selection strategy

Representative test shape:

```ts
expect(nonStreamRecordedMessages).toEqual(streamRecordedMessages);
expect(runtimeTrace.turns.map((turn) => turn.turnId)).toEqual([
  "01-decomposition",
  "02-sufficiency-round-1",
  "03-final-generation",
]);
```

- [ ] **Step 2: Run the focused runtime + integration tests and verify the parity assertions fail if stream still diverges**

Run: `npx vitest run packages/server/test/avatar/runtime.test.ts test/avatar-openapi-integration.test.ts`

Expected: FAIL until stream and non-stream share the same unified runtime preparation path.

- [ ] **Step 3: Refactor runtime internals so stream and non-stream share one preparation phase**

Extract a common preparation step in `packages/server/src/avatar/runtime.ts`, for example:

```ts
const prepared = await this.prepareInference(input);
```

That shared phase must own decomposition, recall, sufficiency, debug turn recording, final-message assembly, and recalled-anchor metadata before either `chat()` or `chatStream()` is invoked.

- [ ] **Step 4: Re-run the focused tests and make them pass**

Run: `npx vitest run packages/server/test/avatar/runtime.test.ts test/avatar-openapi-integration.test.ts`

Expected: PASS with stream/non-stream parity locked.

- [ ] **Step 5: Commit the stream-parity work**

```bash
git add packages/server/src/avatar/runtime.ts packages/server/test/avatar/runtime.test.ts test/avatar-openapi-integration.test.ts
git commit -m "refactor: unify stream and non-stream runtime preparation"
```

## Chunk 3: Turn Reasoning Route Into a Conversation Adapter and Delete ReasoningEngine

### Task 6: Replace `ReasoningEngine` usage in `/:pubKey/reasoning/message` with shared runtime calls

**Files:**

- Modify: `packages/server/src/routes/reasoning.ts`
- Modify: `packages/server/test/routes/reasoning.test.ts`
- Modify: `packages/server/test/avatar/runtime.test.ts`
- Reference: `packages/server/src/routes/ai-chat-completions.ts`

- [ ] **Step 1: Add failing route tests that preserve the current API while no longer depending on `ReasoningEngine` internals**

Add/adjust tests so they verify:

- the route still persists the user message first
- the route still streams assistant tokens and emits `done`
- the assistant message still stores `recalledAnchors` and `anchorSelectionStrategy`
- the route now maps conversation history into caller messages for the shared runtime

Example assertion shape:

```ts
expect(savedAssistantBody.recalledAnchors).toEqual(["a1"]);
expect(savedAssistantBody.anchorSelectionStrategy).toBe("recall-loop");
```

- [ ] **Step 2: Run the route test file and verify failures while the route still constructs `ReasoningEngine`**

Run: `npx vitest run packages/server/test/routes/reasoning.test.ts`

Expected: FAIL once the new unified-runtime expectations are added.

- [ ] **Step 3: Extract a shared runtime construction path inside `routes/reasoning.ts`**

Replace `createEngine(...)` with a constructor/helper that creates the upgraded `AvatarInferenceRuntime` using owner connection, chat client, embedding client, and optional debug writer. Keep the route-specific persistence helpers (`saveMessage`, read receipts, list APIs) in `routes/reasoning.ts`.

- [ ] **Step 4: Map stored conversation history into runtime caller messages**

In the route handler:

1. Persist the incoming user message (as today).
2. Read the conversation rows.
3. Convert them into runtime `conversationTurns` while preserving existing `assistant` / `user` history.
4. Call the unified runtime.
5. Persist the returned assistant output with recalled anchors / selection strategy metadata.

Do not reimplement decomposition/recall/sufficiency inside the route.

- [ ] **Step 5: Preserve route SSE behavior while delegating generation to runtime**

Keep route events (`thinking`, `token`, `done`, `error`) stable where possible. If unified runtime now owns intermediate thinking events, route code should forward them rather than synthesizing new semantics.

- [ ] **Step 6: Re-run the route tests and make them pass**

Run: `npx vitest run packages/server/test/routes/reasoning.test.ts`

Expected: PASS with the route acting as a conversation adapter only.

- [ ] **Step 7: Commit the reasoning-route migration**

```bash
git add packages/server/src/routes/reasoning.ts packages/server/test/routes/reasoning.test.ts
git commit -m "refactor: route reasoning messages through unified avatar runtime"
```

### Task 7: Migrate old engine assertions, then delete `ReasoningEngine`

**Files:**

- Delete: `packages/server/src/reasoning/engine.ts`
- Delete/replace: `packages/server/test/reasoning/engine.test.ts`
- Modify: `packages/server/test/avatar/runtime.test.ts`
- Modify: `packages/server/test/routes/reasoning.test.ts`
- Modify: `test/avatar-openapi-integration.test.ts`

- [ ] **Step 1: Audit every remaining `ReasoningEngine` assertion and move it to runtime/route/debug tests before deletion**

Use the old test file as a checklist. Ensure coverage exists for:

- default decomposition fallback
- temporal validity enforcement
- engine-owned user query/current time behavior
- missing information carry-through
- parse-failure reasoning-chain non-leakage
- artifact latest-directory safety behaviors

- [ ] **Step 2: Run the three target suites and verify they cover the migrated behavior**

Run: `npx vitest run packages/server/test/avatar/runtime.test.ts packages/server/test/routes/reasoning.test.ts test/avatar-openapi-integration.test.ts`

Expected: PASS, demonstrating the old engine coverage has living replacements.

- [ ] **Step 3: Remove production references to `ReasoningEngine`**

Delete imports/usages from routes and any remaining call sites. Confirm no source file imports `../reasoning/engine.js`.

- [ ] **Step 4: Delete the old engine source and obsolete tests**

Remove:

- `packages/server/src/reasoning/engine.ts`
- `packages/server/test/reasoning/engine.test.ts` (or replace with a minimal migration guard if absolutely needed)

Only do this after Step 2 passes.

- [ ] **Step 5: Run the full verification set**

Run:

```bash
npx vitest run \
  packages/server/test/avatar/runtime.test.ts \
  packages/server/test/routes/reasoning.test.ts \
  packages/server/test/reasoning/prompts.test.ts \
  packages/server/test/recall/goal-based-recall.test.ts \
  packages/server/test/interview/engine.test.ts \
  test/avatar-openapi-integration.test.ts
```

Expected: PASS. Record any intentional test-file removals in the final handoff.

- [ ] **Step 6: Commit the final cleanup**

```bash
git add packages/server/src/routes/reasoning.ts packages/server/src/avatar/runtime.ts packages/server/src/reasoning/debug-artifact.ts packages/server/test/avatar/runtime.test.ts packages/server/test/routes/reasoning.test.ts packages/server/test/reasoning/prompts.test.ts packages/server/test/recall/goal-based-recall.test.ts packages/server/test/interview/engine.test.ts test/avatar-openapi-integration.test.ts
git rm packages/server/src/reasoning/engine.ts packages/server/test/reasoning/engine.test.ts
git commit -m "refactor: remove legacy reasoning engine"
```

## Execution Notes

- Keep `.legion/context.md` and `.legion/tasks.md` updated after each task or meaningful checkpoint.
- Do not delete `ReasoningEngine` early; Task 6 is the deletion gate.
- If a task stalls mid-migration, record exactly which runtime capability has already been absorbed and which caller path still points to the old implementation.
- Do not introduce route-level feature flags. Recovery comes from stage clarity and handoff state, not toggles.

Plan complete and saved to `docs/superpowers/plans/2026-03-28-reasoning-runtime-unification.md`. Ready to execute?
