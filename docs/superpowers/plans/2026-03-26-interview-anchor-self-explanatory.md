# Interview Anchor Self-Explanatory Extraction Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make interview anchor extraction produce finer-grained, self-explanatory questions that encode scope, conditions, and term semantics without changing the anchor schema.

**Architecture:** Keep the change inside the interview extraction layer. Tighten the extraction system prompt in `packages/server/src/interview/prompts.ts` so it instructs the model to produce self-explanatory questions, message-local term definitions, and deterministic split rules; keep `packages/server/src/interview/extractor.ts` limited to lightweight first-person/stability normalization only if tests prove prompt-only changes are insufficient. Lock model-behavior requirements at the prompt-contract layer, and reserve extractor tests for parser and post-processing behavior the code actually owns.

**Tech Stack:** TypeScript, Vitest, existing interview prompt and extractor modules

---

## File Map

- Modify: `packages/server/src/interview/prompts.ts`
  - Owns the extraction system prompt contract.
- Modify: `packages/server/test/interview/prompts.test.ts`
  - Owns prompt-contract coverage for self-explanatory question rules, message-local evidence rules, and term-definition split rules.
- Modify: `packages/server/test/interview/extractor.test.ts`
  - Owns extractor parser and post-processing coverage only: XML parsing, first-person normalization, and anti-context wording safeguards.
- Modify: `packages/server/src/interview/extractor.ts` (only if failing tests prove lightweight normalization must expand)
  - Owns post-processing only; do not add schema-like logic or history-dependent reasoning here.

## Spec To Test Traceability

- Self-explanatory question carries scope / condition / object semantics
  - `packages/server/test/interview/prompts.test.ts`
- Message-local evidence only; no history or prior-knowledge supplementation
  - `packages/server/test/interview/prompts.test.ts`
- Term-definition required / optional / forbidden three-state rule
  - `packages/server/test/interview/prompts.test.ts`
- Forced split for definition + judgment and branching-condition cases
  - `packages/server/test/interview/prompts.test.ts`
- No context-dependent wording such as `这个` / `那个` / `刚才提到的` in generated questions
  - `packages/server/test/interview/prompts.test.ts`
  - `packages/server/test/interview/extractor.test.ts` only if prompt-only behavior still needs minimal normalization backup
- Existing dense-message, fact-first, multi-anchor extraction must not regress
  - existing cases in `packages/server/test/interview/extractor.test.ts`
  - focused regression suite in Chunk 2

## Chunk 1: Prompt Contract

### Task 1: Lock the self-explanatory extraction prompt contract before changing behavior

**Files:**

- Modify: `packages/server/test/interview/prompts.test.ts`
- Modify: `packages/server/src/interview/prompts.ts`

- [ ] **Step 1: Write the failing prompt contract test for self-explanatory question rules**

```ts
it("requires self-explanatory questions instead of broad slots", () => {
  const messages = buildExtractionPrompt(
    "我在高压力、信息不完整的时候做独立开发，通常会先快速试错。",
    [],
    [],
  );
  const system = messages[0]?.content ?? "";

  expect(system).toContain("question");
  expect(system).toContain("语境范围");
  expect(system).toContain("成立条件");
  expect(system).toContain("answer");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/server/test/interview/prompts.test.ts -t "requires self-explanatory questions instead of broad slots"`
Expected: FAIL because the current prompt still tells the model to keep conditions in `answer` and does not mention self-explanatory question structure.

- [ ] **Step 3: Write the failing prompt test for message-local evidence rules**

```ts
it("limits semantic supplements to evidence visible in the current message", () => {
  const messages = buildExtractionPrompt("我最近在做 XTP。", [], []);
  const system = messages[0]?.content ?? "";

  expect(system).toContain("当前消息文本");
  expect(system).toContain("可见证据");
  expect(system).toContain("不得依赖会话历史");
  expect(system).toContain("模型先验");
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- packages/server/test/interview/prompts.test.ts -t "limits semantic supplements to evidence visible in the current message"`
Expected: FAIL because the current prompt still uses existing-anchor wording as the main boundary and does not forbid prior-knowledge supplementation.

- [ ] **Step 5: Write the failing prompt contract test for term-definition three-state rules**

```ts
it("defines required, optional, and forbidden term-definition anchor cases", () => {
  const messages = buildExtractionPrompt(
    "我说的 Ralph-Loop，就是目标会在预算允许下持续被唤起推进。",
    [],
    [],
  );
  const system = messages[0]?.content ?? "";

  expect(system).toContain("定义句式");
  expect(system).toContain("必须");
  expect(system).toContain("可选");
  expect(system).toContain("禁止");
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- packages/server/test/interview/prompts.test.ts -t "defines required, optional, and forbidden term-definition anchor cases"`
Expected: FAIL because the current prompt does not define a three-state rule for term-definition anchors.

- [ ] **Step 7: Write the failing prompt contract test for forced split rules and anti-context wording**

```ts
it("forces split behavior and forbids context-dependent wording in questions", () => {
  const messages = buildExtractionPrompt(
    "我说的 Ralph-Loop，就是目标会在预算允许下持续被唤起推进；我喜欢它，因为它不是做完一轮就停。",
    [],
    [],
  );
  const system = messages[0]?.content ?? "";

  expect(system).toContain("同一条消息");
  expect(system).toContain("必须拆");
  expect(system).toContain("这个");
  expect(system).toContain("那个");
  expect(system).toContain("刚才提到的");
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npm test -- packages/server/test/interview/prompts.test.ts -t "forces split behavior and forbids context-dependent wording in questions"`
Expected: FAIL because the current prompt does not yet define the forced split rule or the anti-context wording rule as explicit contract requirements.

- [ ] **Step 9: Update `buildExtractionPrompt()` with the new contract**

Implement all of the following in `packages/server/src/interview/prompts.ts`:

- replace the current “stable slot + conditions in answer” wording with “self-explanatory question” wording
- require message-local evidence for scope, condition, object-semantic, and term-definition supplements
- define the three-state term-definition rule: required / optional / forbidden
- define the split boundary on the message level, not sentence punctuation
- forbid context-dependent pronouns such as `这个` / `那个` / `刚才提到的` in generated questions
- keep the XML output contract unchanged

- [ ] **Step 10: Run the full prompt test file**

Run: `npm test -- packages/server/test/interview/prompts.test.ts`
Expected: PASS

- [ ] **Step 11: Commit the prompt contract changes**

```bash
git add packages/server/src/interview/prompts.ts packages/server/test/interview/prompts.test.ts
git commit -m "test(server): lock self-explanatory extraction prompt contract"
```

## Chunk 2: Extractor Normalization Safeguards

### Task 2: Add extractor-side normalization only if Chunk 1 still leaves code-owned stability gaps

**Files:**

- Modify: `packages/server/test/interview/extractor.test.ts`
- Modify: `packages/server/src/interview/extractor.ts` (only if a failing test proves minimal normalization support is required)

- [ ] **Step 1: Run the full prompt contract file after implementing Chunk 1**

Run: `npm test -- packages/server/test/interview/prompts.test.ts`
Expected: PASS

- [ ] **Step 2: Decide whether extractor changes are actually needed**

Only continue with `packages/server/src/interview/extractor.ts` changes if, after Chunk 1, there is still a code-owned normalization gap such as:

- `用户` is normalized but `刚才提到的` / `那个` survives unchanged in parsed output
- one-off time-bound context survives because the current post-processing already owns that normalization family

If prompt-only changes satisfy the spec and regression suite, skip the remaining extractor-edit steps and go directly to the regression run + commit.

- [ ] **Step 3: If needed, write the failing extractor test for context-dependent owner wording cleanup**

```ts
it("rewrites context-dependent owner questions into stable wording", async () => {
  const client = mockChatClient(
    `<anchor><question>用户刚才提到的那个项目里最重要的是什么？</question><answer>我最看重它解决的认知对齐问题。</answer></anchor>`,
  );

  const result = await extractAnchors({
    chatClient: client,
    userMessage: "ReMi 对我来说最重要的是认知对齐。",
    recentMessages: [],
    existingAnchors: [],
  });

  expect(result[0]?.question.includes("用户")).toBe(false);
  expect(result[0]?.question.includes("刚才提到的")).toBe(false);
  expect(result[0]?.question.includes("那个")).toBe(false);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- packages/server/test/interview/extractor.test.ts -t "rewrites context-dependent owner questions into stable wording"`
Expected: FAIL because `normalizeOwnerQuestion()` currently rewrites `用户` to `我`, but does not strip context-dependent wording like `刚才提到的` or `那个`.

- [ ] **Step 5: If needed, write the failing extractor test for one-off time-bound context cleanup**

```ts
it("removes one-off time-bound context phrases from generated questions", async () => {
  const client = mockChatClient(
    `<anchor><question>我在上周二下午的那个项目判断里最看重什么？</question><answer>我当时最看重能否快速验证方向。</answer></anchor>`,
  );

  const result = await extractAnchors({
    chatClient: client,
    userMessage: "上周二下午我在看一个新方向时，最看重能否快速验证。",
    recentMessages: [],
    existingAnchors: [],
  });

  expect(result[0]?.question).not.toContain("上周二下午");
  expect(result[0]?.question).not.toContain("那个");
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- packages/server/test/interview/extractor.test.ts -t "removes one-off time-bound context phrases from generated questions"`
Expected: FAIL because `normalizeOwnerQuestion()` currently rewrites some leading time phrases, but does not normalize compound one-off forms like `上周二下午的那个`.

- [ ] **Step 7: Add only the minimal normalization support required by the failing tests**

Apply the smallest change set that makes the tests pass:

- only touch `normalizeOwnerQuestion()` in `packages/server/src/interview/extractor.ts`
- strip context-dependent wording such as `刚才提到的` and standalone `那个`
- collapse one-off time-bound context forms like `上周二下午的那个` into stable wording
- preserve the existing `用户` -> `我` and time-bounded normalization behavior
- do not add new schemas, post-processors, or history-aware logic

- [ ] **Step 8: Run the full extractor test file**

Run: `npm test -- packages/server/test/interview/extractor.test.ts`
Expected: PASS

- [ ] **Step 9: Run the focused interview regression suite**

Run: `npm test -- packages/server/test/interview/prompts.test.ts packages/server/test/interview/extractor.test.ts packages/server/test/interview/contradiction.test.ts packages/server/test/interview/engine.test.ts`
Expected: PASS, including the existing dense-message, fact-first, and multi-anchor extractor tests that protect against recall regressions.

- [ ] **Step 10: Commit the normalization and regression changes**

```bash
git add packages/server/src/interview/prompts.ts packages/server/src/interview/extractor.ts packages/server/test/interview/prompts.test.ts packages/server/test/interview/extractor.test.ts
git commit -m "feat(server): extract self-explanatory interview anchors"
```
