# SSE Keepalive For Long Reasoning Streams Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep `/:pubKey/reasoning/message` and `/ai/v1/chat/completions` alive during long reasoning silences by emitting SSE comment heartbeats without changing public business-event semantics.

**Architecture:** Add one small server-side heartbeat helper that tracks the time of the last real SSE write, starts periodic `:\n\n` comment heartbeats after 5 seconds of silence, and stops/resets when real output resumes or the stream ends. Wire that helper into the two stream routes only; leave `AvatarInferenceRuntime` and non-stream paths unchanged so OpenAI compatibility remains protocol-safe.

**Tech Stack:** TypeScript, Hono SSE streaming, Vitest, existing reasoning/openai integration tests

---

## File Map

### Shared keepalive helper

- Create: `packages/server/src/lib/sse-heartbeat.ts`
  - Own the tiny heartbeat contract: comment frame contents, 5s silent threshold, 5s repeat interval, start/stop/reset, and cleanup.
- Create: `packages/server/test/lib/sse-heartbeat.test.ts`
  - Lock timer behavior with fake timers so route tests do not need to prove all helper edge cases.

### Stream routes

- Modify: `packages/server/src/routes/reasoning.ts`
  - Wrap the route's stream writes with the helper and emit comment heartbeats during long silent waits before runtime output and between later gaps.
- Modify: `packages/server/src/routes/ai-chat-completions.ts`
  - Preserve the current `message_start` chunk and all OpenAI chunks, but keep sending comment heartbeats if silence exceeds 5s after that first real write.

### Integration tests

- Modify: `test/reasoning-integration.test.ts`
  - Add a gating test that proves a heartbeat arrives before the first real reasoning event when recall/runtime prep is blocked.
- Modify: `test/avatar-openapi-integration.test.ts`
  - Extend the existing “starts SSE before recall finishes” coverage so it also proves comment heartbeat appears during post-`message_start` silence.

## Chunk 1: Build And Lock The Shared Heartbeat Helper

### Task 1: Add failing unit tests for the heartbeat contract

**Files:**

- Create: `packages/server/test/lib/sse-heartbeat.test.ts`
- Create: `packages/server/src/lib/sse-heartbeat.ts`

- [ ] **Step 1: Write failing helper tests with fake timers**

Add tests for the minimum contract:

```ts
it("emits a comment heartbeat after 5 seconds of real-output silence", async () => {
  vi.useFakeTimers();
  const writes: string[] = [];
  const heartbeat = createSseHeartbeat({
    writeComment: async (value) => writes.push(value),
  });

  heartbeat.recordRealWrite();
  heartbeat.start();
  await vi.advanceTimersByTimeAsync(5000);

  expect(writes).toEqual([":\n\n"]);
});
```

Also cover:

- no heartbeat before 5s
- `recordRealWrite()` resets the silence window
- `stop()` prevents future heartbeats
- repeated `stop()` is safe
- rejected `writeComment()` stops future timers and rejects `failure`

- [ ] **Step 2: Run the helper tests and verify they fail**

Run: `npx vitest run packages/server/test/lib/sse-heartbeat.test.ts`

Expected: FAIL because the helper does not exist yet.

- [ ] **Step 3: Implement the minimal helper**

Create `packages/server/src/lib/sse-heartbeat.ts` with a tiny interface such as:

```ts
type SseHeartbeat = {
  start(): void;
  stop(): void;
  recordRealWrite(): void;
  readonly failure: Promise<never>;
};

export function createSseHeartbeat(deps: {
  writeComment: (frame: string) => Promise<void>;
  onError?: (error: unknown) => void;
  now?: () => number;
  silentMs?: number;
  intervalMs?: number;
}): SseHeartbeat {
  // default silentMs = 5000
  // default intervalMs = 5000
}
```

Implementation rules:

- write exactly the SSE comment frame `":\n\n"`
- track `lastRealWriteAt` separately from heartbeat writes
- after one heartbeat fires, schedule the next one 5s later until real output resumes
- heartbeat write failures must stop future timers and be surfaced to the route through `failure` and/or `onError`
- `failure` only rejects for heartbeat write failures; normal `stop()` must not reject it

- [ ] **Step 4: Re-run the helper tests and make them pass**

Run: `npx vitest run packages/server/test/lib/sse-heartbeat.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the helper contract**

```bash
git add packages/server/src/lib/sse-heartbeat.ts packages/server/test/lib/sse-heartbeat.test.ts
git commit -m "test: lock SSE heartbeat timer contract"
```

## Chunk 2: Wire Heartbeats Into The Reasoning Route

### Task 2: Prove reasoning SSE emits heartbeat during blocked prep

**Files:**

- Modify: `test/reasoning-integration.test.ts`
- Modify: `packages/server/src/routes/reasoning.ts`
- Reference: `packages/server/src/lib/sse-heartbeat.ts`

- [ ] **Step 1: Add a failing reasoning integration test for heartbeat-before-first-event**

Mirror the existing gated-stream pattern and assert the stream yields a comment before `done`/`token`:

```ts
it("POST /reasoning/message emits comment heartbeat while runtime prep is blocked", async () => {
  const res = await signedRequest(...);
  const reader = res.body!.getReader();
  const firstChunk = await reader.read();
  const firstText = new TextDecoder().decode(firstChunk.value);

  expect(firstText).toContain(":\n\n");
  expect(firstText).not.toContain("event: done");
});
```

Use a controllable gate plus fake timers so the test deterministically crosses the 5s threshold without real sleeping. Do not rely on a real 5-second wait.

- [ ] **Step 2: Run the reasoning integration test and verify it fails**

Run: `npx vitest run test/reasoning-integration.test.ts`

Expected: FAIL because the route never writes heartbeats.

- [ ] **Step 3: Wrap real reasoning SSE writes with the heartbeat helper**

In `packages/server/src/routes/reasoning.ts`:

- create the heartbeat at the start of `streamSSE(...)`
- call `heartbeat.start()` before the long async work begins
- call `heartbeat.recordRealWrite()` immediately after each successful real SSE write (`thinking`, `token`, `done`, `error`)
- stop the heartbeat in `finally`

One possible shape:

```ts
const heartbeat = createSseHeartbeat({
  writeComment: async (frame) => {
    await stream.write(frame);
  },
});

heartbeat.start();
try {
  await Promise.race([runReasoningFlow(), heartbeat.failure]);
} finally {
  heartbeat.stop();
}
```

If Hono's SSE helper exposes a better raw-write API than `stream.write(...)`, use that instead; the required observable output remains the exact comment frame.

- [ ] **Step 4: Keep emitter semantics unchanged while recording real writes**

Prefer a tiny local wrapper around `stream.writeSSE(...)` / `emitter.emit*()` so business events stay identical, for example:

```ts
async function emitToken(content: string) {
  await emitter.emitToken(content);
  heartbeat.recordRealWrite();
}
```

Do not add new reasoning event types.

- [ ] **Step 4.5: Prove the heartbeat is readable before the gate is released**

Make the new reasoning integration test follow this order exactly:

1. start the request while the prep/recall gate is still blocked
2. advance fake timers past the silent threshold
3. `await Promise.race([reader.read(), timeoutPromise])`
4. assert the pre-release bytes already contain `":\n\n"`
5. only then release the gate and finish the normal `done` assertions

This is the flush proof for the reasoning route; do not allow the heartbeat assertion to pass only after the final event has already arrived.

- [ ] **Step 5: Re-run reasoning integration tests and make them pass**

Run: `npx vitest run test/reasoning-integration.test.ts`

Expected: PASS, including the new heartbeat assertion and existing `done` payload checks.

- [ ] **Step 6: Commit the reasoning-route heartbeat wiring**

```bash
git add packages/server/src/routes/reasoning.ts test/reasoning-integration.test.ts
git commit -m "feat: keep reasoning SSE streams alive"
```

## Chunk 3: Preserve OpenAI Semantics While Adding Heartbeats

### Task 3: Prove OpenAI stream sends heartbeat after `message_start` silence

**Files:**

- Modify: `test/avatar-openapi-integration.test.ts`
- Modify: `packages/server/src/routes/ai-chat-completions.ts`
- Reference: `packages/server/src/lib/sse-heartbeat.ts`

- [ ] **Step 1: Add a failing OpenAI integration assertion for post-`message_start` heartbeat**

Extend the existing gated test so it reads from the live reader before recall is released and confirms:

```ts
expect(firstChunkText).toContain('"role":"assistant"');
expect(firstChunkText).toContain(":\n\n");
expect(firstChunkText).not.toContain('"content":"hello"');
```

Keep the assertion tolerant to chunk boundaries: concatenate all bytes read before releasing the gate and search for both the `message_start` JSON and the comment heartbeat.
Use fake timers to cross the 5s silence threshold deterministically. If the live stream test stack cannot cooperate with fake timers, inject a shorter test-only heartbeat interval through the helper while keeping the production default at 5s.

- [ ] **Step 2: Run the OpenAI integration test and verify it fails**

Run: `npx vitest run test/avatar-openapi-integration.test.ts`

Expected: FAIL because only the `message_start` chunk is emitted today.

- [ ] **Step 3: Add heartbeat tracking around the OpenAI stream loop**

In `packages/server/src/routes/ai-chat-completions.ts`:

- create one heartbeat per request
- record the initial `message_start` write as a real write
- keep the heartbeat alive while waiting for `createRequest()` and later runtime stream gaps
- record each real OpenAI chunk and `[DONE]` write
- race the stream body work against `heartbeat.failure` so timer-driven write failures enter the existing route error path
- stop the heartbeat in `finally`

If the transport is already gone and heartbeat writing fails, follow the existing stream shutdown path and do not invent an extra compensating OpenAI error chunk just for the heartbeat failure.

The route should still behave like:

```ts
await writeOpenAiChunk(messageStart);
heartbeat.recordRealWrite();

const request = await runtime.createRequest(...);
for await (const event of runtime.runStream(request)) {
  ...
  await writeOpenAiChunk(event);
  heartbeat.recordRealWrite();
}

await stream.writeSSE({ data: "[DONE]" });
heartbeat.recordRealWrite();
```

- [ ] **Step 4: Preserve strict compatibility on success and error paths**

Do not change:

- the first assistant-role `message_start` chunk
- chunk JSON schemas
- error JSON payloads
- trailing `[DONE]`

Heartbeat frames must remain SSE comments only; never send empty `data:` blocks.

- [ ] **Step 5: Re-run the OpenAI integration test and make it pass**

Run: `npx vitest run test/avatar-openapi-integration.test.ts`

Expected: PASS, with both the existing chunk assertions and the new comment-heartbeat assertion.

- [ ] **Step 6: Commit the OpenAI-route heartbeat wiring**

```bash
git add packages/server/src/routes/ai-chat-completions.ts test/avatar-openapi-integration.test.ts
git commit -m "feat: keep OpenAI SSE streams alive"
```

## Chunk 4: Final Verification And Cleanup

### Task 4: Run the targeted verification set and confirm no protocol regressions

**Files:**

- Test: `packages/server/test/lib/sse-heartbeat.test.ts`
- Test: `test/reasoning-integration.test.ts`
- Test: `test/avatar-openapi-integration.test.ts`

- [ ] **Step 1: Run the complete targeted verification set**

Run: `npx vitest run packages/server/test/lib/sse-heartbeat.test.ts test/reasoning-integration.test.ts test/avatar-openapi-integration.test.ts`

Expected: PASS.

- [ ] **Step 2: If heartbeat timing tests are flaky, tighten them before broadening scope**

Use fake timers / controlled gates until the tests prove:

- a comment heartbeat arrives during a silent window
- business events/chunks still arrive unchanged
- no extra event schema needs parsing
- real events/chunks still preserve their original order after heartbeat frames are introduced

Do not fall back to real 5-second sleeps. If fake timers are incompatible with a specific integration path, lower the helper interval through test-only dependency injection and keep the production default constants unchanged.

- [ ] **Step 3: Run one adjacent regression check for route/runtime safety**

Run: `npx vitest run packages/server/test/routes/reasoning.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit the final verification state**

```bash
git add packages/server/src/lib/sse-heartbeat.ts packages/server/src/routes/reasoning.ts packages/server/src/routes/ai-chat-completions.ts packages/server/test/lib/sse-heartbeat.test.ts test/reasoning-integration.test.ts test/avatar-openapi-integration.test.ts
git commit -m "test: verify SSE heartbeat coverage"
```
