# Interview Anchor Extraction Recall-First Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Increase interview anchor extraction recall so explicit facts are recorded more reliably while keeping cognitive anchors, current XML output, and current schema intact.

**Architecture:** Keep the implementation scoped to the interview extraction layer. Update the extraction prompt in `packages/server/src/interview/prompts.ts` so it prefers fact-first, recall-first behavior with stable first-person questions, then lock the behavior with focused prompt, extractor, and contradiction-boundary tests. Avoid schema, route, recall, or engine orchestration changes unless a failing test proves a minimal compatibility adjustment is required.

**Tech Stack:** TypeScript, Vitest, existing interview prompt/extractor/contradiction modules

---

## File Map

- Modify: `packages/server/src/interview/prompts.ts`
  - Owns extraction prompt rules, wording, and any de-identified examples.
- Create: `packages/server/test/interview/prompts.test.ts`
  - Owns prompt-contract assertions only: recall-first rules, first-person wording, de-identified guidance, stable question wording rules.
- Modify: `packages/server/test/interview/extractor.test.ts`
  - Owns extractor behavior only: XML parsing, multiple anchors, fact + cognition coexistence, near-topic new-granularity behavior, and output fixtures.
- Modify: `packages/server/test/interview/contradiction.test.ts`
  - Owns contradiction-boundary coverage for “state update but not contradiction”.
- Verify: `packages/server/test/interview/engine.test.ts`
  - Guards against accidental regressions in adjacent interview flow behavior.

## Chunk 1: Prompt Contract

### Task 1: Lock the extraction prompt contract before changing code

**Files:**

- Create: `packages/server/test/interview/prompts.test.ts`
- Modify: `packages/server/src/interview/prompts.ts`

- [ ] **Step 1: Write the failing prompt test for recall-first rules**

```ts
it("buildExtractionPrompt emphasizes fact-first recall", () => {
  const messages = buildExtractionPrompt(
    "我最近一边准备考试，一边在做一个小工具，也在投简历。",
    [],
    [],
  );
  const system = messages[0]?.content ?? "";

  expect(system).toContain("当前阶段以召回率优先");
  expect(system).toContain("优先提取用户明确说出的身份、事项、目标、事件、经历");
  expect(system).not.toContain("通用的、可复用的认知问题");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/server/test/interview/prompts.test.ts -t "buildExtractionPrompt emphasizes fact-first recall"`
Expected: FAIL because the current prompt still uses abstraction-first wording.

- [ ] **Step 3: Write the failing prompt test for first-person owner wording and de-identified examples**

```ts
it("buildExtractionPrompt requires first-person owner questions and de-identified examples", () => {
  const messages = buildExtractionPrompt("我做决定时更看重长期空间，不太在意短期波动。", [], []);
  const system = messages[0]?.content ?? "";

  expect(system).toContain("必须使用“我”作为主语");
  expect(system).toContain("不得使用“用户”");
  expect(system).toContain("使用完全脱敏、虚构、不可回溯到真实用户的数据");
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- packages/server/test/interview/prompts.test.ts -t "buildExtractionPrompt requires first-person owner questions and de-identified examples"`
Expected: FAIL because the current prompt does not include these constraints.

- [ ] **Step 5: Write the failing prompt test for stable question wording**

```ts
it("buildExtractionPrompt forbids short-lived context in question wording", () => {
  const messages = buildExtractionPrompt(
    "上周二下午我去面试了一家创业公司，现在还在等结果。",
    [],
    [],
  );
  const system = messages[0]?.content ?? "";

  expect(system).toContain("不把短期时间词直接写入 question");
  expect(system).toContain("question 应锚定一个稳定信息槽位");
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- packages/server/test/interview/prompts.test.ts -t "buildExtractionPrompt forbids short-lived context in question wording"`
Expected: FAIL because the current prompt does not state these stability rules.

- [ ] **Step 7: Write the minimal production change in `buildExtractionPrompt()`**

Update `packages/server/src/interview/prompts.ts` so the extraction prompt:

- replaces abstraction-first rules with recall-first, fact-first rules
- allows stable fact questions and stable cognition questions
- requires `我` for owner-facing facts and cognition; forbids `用户`
- says to skip only obviously equivalent duplicates
- says to use only de-identified fictional examples
- keeps the XML output contract unchanged

- [ ] **Step 8: Run the full prompt-contract test file**

Run: `npm test -- packages/server/test/interview/prompts.test.ts`
Expected: PASS

- [ ] **Step 9: Commit the prompt contract changes**

```bash
git add packages/server/src/interview/prompts.ts packages/server/test/interview/prompts.test.ts
git commit -m "test(server): lock interview extraction prompt contract"
```

## Chunk 2: Extraction Behavior Coverage

### Task 2: Lock fact recall, coexistence, and stable output behavior

**Files:**

- Modify: `packages/server/test/interview/extractor.test.ts`
- Modify: `packages/server/src/interview/prompts.ts`
- Modify: `packages/server/src/interview/extractor.ts` (only if a failing test proves post-processing must change)

- [ ] **Step 1: Write the failing extractor test for multiple fact anchors**

```ts
it("extracts multiple fact anchors from one dense message", async () => {
  const client = mockChatClient(`
<anchor><question>我最近在忙什么？</question><answer>最近一边准备考试，一边做一个小工具，也在投简历。</answer></anchor>
<anchor><question>我现在在做什么项目？</question><answer>我在做一个小工具。</answer></anchor>
<anchor><question>我最近在推进哪些求职事项？</question><answer>我在投简历，也在准备考试。</answer></anchor>`);

  const result = await extractAnchors({
    chatClient: client,
    userMessage: "我最近一边准备考试，一边在做一个小工具，也在投简历。",
    recentMessages: [],
    existingAnchors: [],
  });

  expect(result).toHaveLength(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/server/test/interview/extractor.test.ts -t "extracts multiple fact anchors from one dense message"`
Expected: FAIL because this exact multi-fact behavior is not yet covered in the suite.

- [ ] **Step 3: Write the failing extractor test for fact + cognition coexistence**

```ts
it("keeps fact and cognition anchors side by side", async () => {
  const client = mockChatClient(`
<anchor><question>我现在在做什么工作方式选择？</question><answer>我现在在做独立开发。</answer></anchor>
<anchor><question>我的协作偏好是什么样的？</question><answer>我不喜欢太重的团队协作流程。</answer></anchor>`);

  const result = await extractAnchors({
    chatClient: client,
    userMessage: "我现在在做独立开发，因为我不喜欢太重的团队协作流程。",
    recentMessages: [],
    existingAnchors: [],
  });

  expect(result).toHaveLength(2);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- packages/server/test/interview/extractor.test.ts -t "keeps fact and cognition anchors side by side"`
Expected: FAIL because this coexistence rule is not yet covered in the suite.

- [ ] **Step 5: Write the failing extractor test for first-person cognitive question wording**

```ts
it("keeps owner cognition questions in first person", async () => {
  const client = mockChatClient(
    `<anchor><question>我的决策偏好是什么样的？</question><answer>我做决定时更看重长期空间，不太在意短期波动。</answer></anchor>`,
  );

  const result = await extractAnchors({
    chatClient: client,
    userMessage: "我做决定时更看重长期空间，不太在意短期波动。",
    recentMessages: [],
    existingAnchors: [],
  });

  expect(result[0]?.question.startsWith("我")).toBe(true);
  expect(result[0]?.question.includes("用户")).toBe(false);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- packages/server/test/interview/extractor.test.ts -t "keeps owner cognition questions in first person"`
Expected: FAIL because this rule is not yet covered in the suite.

- [ ] **Step 7: Write the failing extractor test for stable question wording on time-bound facts**

```ts
it("accepts stable question wording for time-bound updates", async () => {
  const client = mockChatClient(
    `<anchor><question>我最近在经历什么求职进展？</question><answer>上周二下午我去面试了一家创业公司，现在还在等结果。</answer></anchor>`,
  );

  const result = await extractAnchors({
    chatClient: client,
    userMessage: "上周二下午我去面试了一家创业公司，现在还在等结果。",
    recentMessages: [],
    existingAnchors: [],
  });

  expect(result[0]?.question).not.toContain("上周二下午");
  expect(result[0]?.question).not.toContain("刚才");
  expect(result[0]?.question).not.toContain("当时");
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npm test -- packages/server/test/interview/extractor.test.ts -t "accepts stable question wording for time-bound updates"`
Expected: FAIL because this stability rule is not yet covered in the suite.

- [ ] **Step 9: Write the failing extractor test for near-topic but new-granularity facts**

```ts
it("does not treat new lower-level facts as already covered", async () => {
  const client = mockChatClient(
    `<anchor><question>我最近在推进哪些求职事项？</question><answer>我最近主要在投后端岗位，也在准备系统设计面试。</answer></anchor>`,
  );

  const result = await extractAnchors({
    chatClient: client,
    userMessage: "我最近主要在投后端岗位，也在准备系统设计面试。",
    recentMessages: [],
    existingAnchors: [
      {
        id: "a1",
        question: "我最近在忙什么？",
        answer: "在找工作",
        source: "interview",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });

  expect(result).toHaveLength(1);
  expect(result[0]?.question).toBe("我最近在推进哪些求职事项？");
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npm test -- packages/server/test/interview/extractor.test.ts -t "does not treat new lower-level facts as already covered"`
Expected: FAIL because this dedupe boundary is not yet covered in the suite.

- [ ] **Step 11: Write the failing extractor test for no new information**

```ts
it("returns empty array when the message adds no new information", async () => {
  const client = mockChatClient("没有新的可提取内容。");

  const result = await extractAnchors({
    chatClient: client,
    userMessage: "我最近在找工作。",
    recentMessages: [],
    existingAnchors: [
      {
        id: "a1",
        question: "我最近在忙什么？",
        answer: "我最近在找工作。",
        source: "interview",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });

  expect(result).toEqual([]);
});
```

- [ ] **Step 12: Run test to verify it fails**

Run: `npm test -- packages/server/test/interview/extractor.test.ts -t "returns empty array when the message adds no new information"`
Expected: FAIL because this acceptance case is not yet covered as an explicit fixture.

- [ ] **Step 13: Make the minimal production change needed for green**

Allowed changes:

- update `packages/server/src/interview/prompts.ts` if prompt wording still does not express the desired extraction behavior
- update `packages/server/src/interview/extractor.ts` only if a failing test proves parser or post-filter logic blocks a passing case
- do not change XML parsing contract or widen scope beyond extraction behavior

Commit ownership rule:

- if a `prompts.ts` change is needed to satisfy extractor behavior or empty-result semantics, keep it in this Task 2 commit
- reserve any later `prompts.ts` edits in Task 3 only for contradiction-specific compatibility fixes proven by contradiction tests

- [ ] **Step 14: Refactor older extractor fixtures to match the new contract**

Update older XML fixtures so owner-oriented questions use `我` where appropriate, while preserving coverage for XML parsing success, multiple anchor parsing, empty results, LLM errors, and missing field filtering.

- [ ] **Step 15: Run the full extractor test file**

Run: `npm test -- packages/server/test/interview/extractor.test.ts`
Expected: PASS

- [ ] **Step 16: Commit extractor behavior coverage**

```bash
git add packages/server/test/interview/extractor.test.ts packages/server/src/interview/prompts.ts packages/server/src/interview/extractor.ts
git commit -m "test(server): cover recall-first interview extraction"
```

## Chunk 3: Contradiction Boundary And Verification

### Task 3: Lock the non-contradictory state-update boundary

**Files:**

- Modify: `packages/server/test/interview/contradiction.test.ts`
- Modify: `packages/server/src/interview/prompts.ts` or `packages/server/src/interview/contradiction.ts` only if a failing test proves it is necessary

- [ ] **Step 1: Write the failing contradiction test for time-progressed updates**

```ts
it("does not mark time-progressed updates as contradictions", async () => {
  const client = mockChatClient("这些是状态更新，不构成矛盾。");

  const result = await detectContradictions({
    chatClient: client,
    newAnchors: [{ question: "我最近在经历什么求职进展？", answer: "我拿到二面了。" }],
    existingAnchors: [
      {
        id: "a1",
        question: "我最近在经历什么求职进展？",
        answer: "我刚投完简历。",
        source: "interview",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });

  expect(result).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/server/test/interview/contradiction.test.ts -t "does not mark time-progressed updates as contradictions"`
Expected: FAIL because this boundary is not yet explicitly covered.

- [ ] **Step 3: Make the minimal change needed for green**

Prefer fixture alignment first. Only modify production code if the failing test proves the current contradiction prompt or parser cannot preserve the existing “观点演变不算矛盾” rule.

Commit ownership rule:

- if no contradiction-specific production changes are needed, this commit should contain only `packages/server/test/interview/contradiction.test.ts`
- only include `packages/server/src/interview/prompts.ts` or `packages/server/src/interview/contradiction.ts` if the contradiction test proves they are necessary

- [ ] **Step 4: Run the contradiction test file**

Run: `npm test -- packages/server/test/interview/contradiction.test.ts`
Expected: PASS

- [ ] **Step 5: Commit contradiction boundary coverage**

```bash
git add packages/server/test/interview/contradiction.test.ts packages/server/src/interview/prompts.ts packages/server/src/interview/contradiction.ts
git commit -m "test(server): lock non-contradictory interview updates"
```

### Task 4: Verify focused interview behavior and repository health

**Files:**

- Test: `packages/server/test/interview/prompts.test.ts`
- Test: `packages/server/test/interview/extractor.test.ts`
- Test: `packages/server/test/interview/contradiction.test.ts`
- Test: `packages/server/test/interview/engine.test.ts`

- [ ] **Step 1: Run the focused interview suite**

Run: `npm test -- packages/server/test/interview/prompts.test.ts packages/server/test/interview/extractor.test.ts packages/server/test/interview/contradiction.test.ts packages/server/test/interview/engine.test.ts`
Expected: PASS

- [ ] **Step 2: If any focused test fails, make only minimal compatible adjustments**

Prefer tightening prompt text or test fixtures over widening implementation scope. Do not change engine orchestration unless a failing test proves it is necessary.

- [ ] **Step 3: Re-run the focused interview suite**

Run: `npm test -- packages/server/test/interview/prompts.test.ts packages/server/test/interview/extractor.test.ts packages/server/test/interview/contradiction.test.ts packages/server/test/interview/engine.test.ts`
Expected: PASS with no new failures

- [ ] **Step 4: Run the full repository test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit only if Step 2 required new code changes**

```bash
git add packages/server/src/interview/prompts.ts packages/server/src/interview/extractor.ts packages/server/src/interview/contradiction.ts packages/server/test/interview/prompts.test.ts packages/server/test/interview/extractor.test.ts packages/server/test/interview/contradiction.test.ts
git commit -m "feat(server): increase interview anchor extraction recall"
```

If Step 2 made no changes, skip this commit and keep the earlier green commits.
