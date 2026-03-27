# Avatar Investigative Prompt Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the avatar system prompt require the model to investigate caller environment before giving decisions or plans when that context materially affects the answer.

**Architecture:** Keep the change inside the existing avatar prompt assembly path by updating `buildPlatformSegment()` in `packages/server/src/avatar/message-augmentation.ts`. Verify it with deterministic prompt contract tests grouped by canonical scenario, plus one integration-level regression anchor that checks the injected downstream system message still carries the key prompt rules, without introducing new message protocol or runtime state.

**Tech Stack:** TypeScript, Vitest, existing avatar OpenAI integration test harness

---

## File Map

- Modify: `packages/server/src/avatar/message-augmentation.ts`
  - Update the platform system prompt text to encode the new “investigate before reasoning” rules.
- Create: `packages/server/test/avatar/message-augmentation.test.ts`
  - Add deterministic tests for `buildPlatformSegment()` so the prompt contract is explicit, scenario-based, and stable.
- Modify: `test/avatar-openapi-integration.test.ts`
  - Keep one end-to-end assertion that the downstream system message still contains the injected platform prompt after the wording change.

## Chunk 1: Prompt Contract Tests

### Task 1: Add deterministic tests for the platform prompt contract

**Files:**

- Create: `packages/server/test/avatar/message-augmentation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildPlatformSegment } from "../../src/avatar/message-augmentation.js";

describe("buildPlatformSegment", () => {
  it("requires investigation before environment-dependent reasoning", () => {
    const prompt = buildPlatformSegment();

    expect(prompt).toContain(
      "Do not jump into reasoning before understanding the caller's environment",
    );
    expect(prompt).toContain("current task");
    expect(prompt).toContain("constraints");
    expect(prompt).toContain("relationship");
  });

  it("requires the minimum necessary questions when key context is missing", () => {
    const prompt = buildPlatformSegment();

    expect(prompt).toContain("minimum necessary questions");
  });

  it("allows direct answers for low-risk or environment-independent requests", () => {
    const prompt = buildPlatformSegment();

    expect(prompt).toContain("low-risk");
    expect(prompt).toContain("directly");
  });

  it("requires explicit assumptions and no repeated questioning when context is already sufficient", () => {
    const prompt = buildPlatformSegment();

    expect(prompt).toContain("state assumptions explicitly");
    expect(prompt).toContain("existing context");
  });

  it("allows a temporary answer only with explicit assumptions when the user needs a judgment before context is complete", () => {
    const prompt = buildPlatformSegment();

    expect(prompt).toContain("incomplete context");
    expect(prompt).toContain("temporary answer");
    expect(prompt).toContain("state assumptions explicitly");
  });

  it("treats missing goals, constraints, permissions, time, or relationship boundaries as investigation triggers when they affect the answer", () => {
    const prompt = buildPlatformSegment();

    expect(prompt).toContain("permissions");
    expect(prompt).toContain("time");
    expect(prompt).toContain("when they materially affect the answer");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/server/test/avatar/message-augmentation.test.ts`
Expected: FAIL because the new prompt rules are not in `buildPlatformSegment()` yet.

- [ ] **Step 3: Write minimal implementation**

**Files:**

- Modify: `packages/server/src/avatar/message-augmentation.ts`

Update `buildPlatformSegment()` so it satisfies the exact assertions from Step 1 while keeping the existing identity/runtime framing and avoiding a long SOP. Keep the final text short, but ensure it explicitly covers the four canonical scenarios from the spec:

- environment-dependent decisions must investigate first
- missing key context triggers minimum necessary questions
- low-risk or environment-independent requests can be answered directly
- sufficient context avoids repeated questions, and uncertainty requires explicit assumptions
- if context is incomplete but the user still needs a temporary judgment, the answer must stay conditional and assumption-explicit
- missing goals, constraints, permissions, time, or relationship boundaries trigger investigation only when they materially affect the answer

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/server/test/avatar/message-augmentation.test.ts`
Expected: PASS

## Chunk 2: Integration Anchor

### Task 2: Add an integration regression anchor for the injected platform prompt

**Files:**

- Modify: `test/avatar-openapi-integration.test.ts`

- [ ] **Step 1: Update the integration regression anchor**

Adjust the existing assertion in `test/avatar-openapi-integration.test.ts` so it checks for the same injected contract phrases already defined by Chunk 1. Chunk 1 is the only prompt text contract source; Chunk 2 only proves those rules survive end-to-end injection.

Anchor the downstream `system` content with this minimum set of contract phrases:

`Do not jump into reasoning before understanding the caller's environment`

`minimum necessary questions`

`existing context`

`state assumptions explicitly`

- [ ] **Step 2: Run the integration test as a regression check**

Run: `npm test -- test/avatar-openapi-integration.test.ts`
Expected: PASS if the implementation from Chunk 1 is correctly injected end-to-end.

- [ ] **Step 3: Tighten wording only if the regression anchor reveals drift**

If this check fails, first determine whether the issue is in prompt injection or in prompt contract wording drift. Only then adjust `packages/server/src/avatar/message-augmentation.ts` so the integration assertion and the unit-level prompt contract stay aligned.

- [ ] **Step 4: Run targeted tests to verify they pass**

Run: `npm test -- packages/server/test/avatar/message-augmentation.test.ts test/avatar-openapi-integration.test.ts`
Expected: PASS

## Chunk 3: Final Verification

### Task 3: Run full verification

**Files:**

- Verify: `packages/server/src/avatar/message-augmentation.ts`
- Verify: `packages/server/test/avatar/message-augmentation.test.ts`
- Verify: `test/avatar-openapi-integration.test.ts`

- [ ] **Step 1: Run targeted tests, then the full suite**

Run: `npm test -- packages/server/test/avatar/message-augmentation.test.ts test/avatar-openapi-integration.test.ts`
Expected: PASS

Run: `npm test`
Expected: PASS with zero failing test files.

- [ ] **Step 2: Inspect git diff for scope control**

Run: `git diff -- packages/server/src/avatar/message-augmentation.ts packages/server/test/avatar/message-augmentation.test.ts test/avatar-openapi-integration.test.ts`
Expected: Only the prompt wording and directly related tests changed.

- [ ] **Step 3: Commit implementation work**

```bash
git add packages/server/src/avatar/message-augmentation.ts packages/server/test/avatar/message-augmentation.test.ts test/avatar-openapi-integration.test.ts
git commit -m "feat: require context investigation before avatar reasoning"
```

Skip this commit only if the implementation was already committed earlier without any post-verification changes.
