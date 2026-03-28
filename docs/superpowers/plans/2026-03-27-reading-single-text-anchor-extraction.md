# Reading Single-Text Anchor Extraction Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first `阅读` flow as a discoverable standalone page where the user pastes one long text, reviews AI-generated anchor-questionnaire items, and submits a full round of three-state feedback before any persistence side effects happen.

**Architecture:** Keep v1 inside the existing web app. Add a Discover entry and `/read` route, then implement the flow around a storage-backed `reading session` state machine: input -> questionnaire round -> round summary -> continue / close. Put deterministic rules in a pure helper module, session lifecycle in a dedicated hook, and extraction/summarization behind a narrow adapter so the UI stays testable and the implementation can evolve without breaking the questionnaire contract.

**Tech Stack:** React, React Router, TypeScript, existing shadcn/ui components, `sonner`, i18next, Vitest, Testing Library

---

## File Map

### New files

- `packages/web/src/pages/ReadingPage.tsx` - standalone `/read` page with input, questionnaire, summary, and closed-state rendering
- `packages/web/src/hooks/use-reading-session.ts` - owns session restore/save, round state, submit transitions, next-round requests, and close behavior
- `packages/web/src/lib/reading-session.ts` - pure constants and helpers for UTF-16 counting, cap enforcement, dedupe, queue shaping, and restore validation
- `packages/web/src/lib/reading-api.ts` - narrow adapter for first-round extraction, summary generation, and next-round generation
- `packages/web/test/pages/DiscoverPage.test.tsx` - Discover entry coverage
- `packages/web/test/pages/ReadingPage.test.tsx` - page-level behavior for boundaries, questionnaire gating, summary interactions, and close flow
- `packages/web/test/hooks/use-reading-session.test.tsx` - hook coverage for persistence, TTL, submit semantics, and next-round assembly
- `packages/web/test/lib/reading-session.test.ts` - pure helper coverage for count semantics and deterministic composition

### Modified files

- `packages/web/src/App.tsx` - register `/read` route
- `packages/web/src/pages/DiscoverPage.tsx` - replace placeholder-only body with a menu-style reading entry
- `packages/web/public/locales/zh/translation.json` - add `discover.reading.*` and `reading.*` copy
- `packages/web/public/locales/en/translation.json` - add English equivalents
- `packages/web/test/pages/App.test.tsx` - mock `ReadingPage` and assert `/read` routing

### Existing files to reference while implementing

- `packages/web/src/pages/MePage.tsx` - menu-row styling to mirror on Discover
- `packages/web/test/helpers/test-utils.tsx` - use `renderWithProviders(..., { route })`; do not invent new test helpers unless you add them explicitly

## Shared constants and contracts

- Input count uses UTF-16 `.length`
- `< 800` chars: show soft warning, still allow start
- `> 50000` chars: block start with error copy
- Each round shows at most `18` items
- Each theme shows at most `6` items
- All current-round items must be answered before submit
- No side effects happen until `submitRound`
- Unfinished sessions persist for `24` hours, then expire
- Restore must include current round, selections, correction hints, candidate pool, and review queue
- Closing the session marks it closed and prevents auto-resume into a new round

## Chunk 1: Discover Entry and Route

### Task 1: Add failing route coverage for `/read`

**Files:**

- Modify: `packages/web/test/pages/App.test.tsx`
- Modify: `packages/web/src/App.tsx`

- [ ] **Step 1: Add a failing `/read` route test**

```tsx
vi.doMock("../../src/pages/ReadingPage", () => ({
  ReadingPage: () => <div>reading-page</div>,
}));

it("renders the reading route as a standalone authenticated page", async () => {
  mockAppModules(({ children }) => <div data-testid="auth-provider">{children}</div>);
  window.history.replaceState({}, "", "/read");

  const { default: App } = await import("../../src/App");

  render(<App />);

  expect(await screen.findByText("reading-page")).toBeInTheDocument();
  expect(screen.getByTestId("auth-provider")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused route test and verify it fails**

Run: `npm test -- packages/web/test/pages/App.test.tsx -t "renders the reading route as a standalone authenticated page"`
Expected: FAIL because `/read` is not registered yet.

- [ ] **Step 3: Register `/read` in `App.tsx`**

```tsx
import { ReadingPage } from "./pages/ReadingPage";

<Route path="/read" element={<ReadingPage />} />;
```

- [ ] **Step 4: Re-run the focused route test and verify it passes**

Run: `npm test -- packages/web/test/pages/App.test.tsx -t "renders the reading route as a standalone authenticated page"`
Expected: PASS

### Task 2: Add the Discover entry with existing test helpers only

**Files:**

- Create: `packages/web/test/pages/DiscoverPage.test.tsx`
- Modify: `packages/web/src/pages/DiscoverPage.tsx`
- Modify: `packages/web/public/locales/zh/translation.json`
- Modify: `packages/web/public/locales/en/translation.json`

- [ ] **Step 1: Write a failing Discover page test using `renderWithProviders`**

```tsx
import { renderWithProviders, screen } from "../helpers/test-utils";

it("shows the reading entry and links to /read", () => {
  renderWithProviders(<DiscoverPage />, { route: "/discover" });

  const link = screen.getByRole("link", { name: /阅读|Reading/i });
  expect(link).toHaveAttribute("href", "/read");
  expect(screen.getByText(/把一段长文本交给 AI|Give AI a long text/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused Discover test and verify it fails**

Run: `npm test -- packages/web/test/pages/DiscoverPage.test.tsx`
Expected: FAIL because the page still renders only the placeholder state.

- [ ] **Step 3: Implement the Discover entry with Me-style menu rows**

```tsx
const entries = [
  {
    icon: BookOpen,
    titleKey: "discover.reading.title",
    descriptionKey: "discover.reading.description",
    to: "/read",
  },
] as const;
```

- [ ] **Step 4: Add Discover entry copy in both locales**

```json
"discover": {
  "reading": {
    "title": "阅读",
    "description": "把一段长文本交给 AI，批量提炼灵魂锚点"
  }
}
```

- [ ] **Step 5: Re-run the Discover test and verify it passes**

Run: `npm test -- packages/web/test/pages/DiscoverPage.test.tsx`
Expected: PASS

## Chunk 2: Pure Rules and Adapter Contracts

### Task 3: Lock down pure helper behavior first

**Files:**

- Create: `packages/web/test/lib/reading-session.test.ts`
- Create: `packages/web/src/lib/reading-session.ts`

- [ ] **Step 1: Write failing pure tests for count semantics, caps, and queue composition**

```ts
it("counts input length with UTF-16 length semantics", () => {
  expect(countReadingChars("a\n🙂")).toBe("a\n🙂".length);
});

it("keeps review items first and enforces round and theme caps", () => {
  const result = composeNextRound({
    approvedAnchors: [approved("q-approved")],
    reviewQueue: [review("a-1", "theme-a"), review("a-2", "theme-a"), review("a-3", "theme-a")],
    candidatePool: [candidate("b-1", "theme-b", 0.9), candidate("c-1", "theme-c", 0.8)],
    maxItems: 4,
    maxPerTheme: 2,
  });

  expect(result.items.map((item) => item.id)).toEqual(["a-1", "a-2", "b-1", "c-1"]);
  expect(result.deferredReviewQueue.map((item) => item.id)).toEqual(["a-3"]);
});
```

- [ ] **Step 2: Run the helper test file and verify it fails**

Run: `npm test -- packages/web/test/lib/reading-session.test.ts`
Expected: FAIL because the helper module does not exist yet.

- [ ] **Step 3: Implement the pure helper module**

```ts
export const READING_MIN_LENGTH_HINT = 800;
export const READING_MAX_LENGTH = 50_000;
export const READING_ROUND_MAX_ITEMS = 18;
export const READING_THEME_MAX_ITEMS = 6;
export const READING_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function countReadingChars(text: string) {
  return text.length;
}

export function composeNextRound(input: ComposeNextRoundInput): ComposeNextRoundResult {
  // drop approved duplicates
  // keep review items first in prior appearance order
  // append candidate-pool items by score
  // enforce theme and round caps, returning deferred queues
}
```

- [ ] **Step 4: Re-run the helper test file and verify it passes**

Run: `npm test -- packages/web/test/lib/reading-session.test.ts`
Expected: PASS

### Task 4: Define the reading adapter contract before the hook

**Files:**

- Create: `packages/web/src/lib/reading-api.ts`
- Modify: `packages/web/test/hooks/use-reading-session.test.tsx`

- [ ] **Step 1: Write a failing hook test that injects a reading adapter**

```tsx
it("starts a session from adapter-provided first-round data", async () => {
  const readingApi = {
    generateFirstRound: vi.fn().mockResolvedValue(seedGenerationResult()),
    summarizeRound: vi.fn(),
    generateNextRound: vi.fn(),
  };

  const { result } = renderHook(() => useReadingSession({ readingApi }));

  await act(async () => {
    await result.current.startSession({ text: seededLongText });
  });

  expect(readingApi.generateFirstRound).toHaveBeenCalled();
  expect(result.current.session?.currentRound.items).toHaveLength(3);
});
```

- [ ] **Step 2: Run the focused hook test and verify it fails**

Run: `npm test -- packages/web/test/hooks/use-reading-session.test.tsx -t "starts a session from adapter-provided first-round data"`
Expected: FAIL because the adapter contract does not exist yet.

- [ ] **Step 3: Implement the adapter interface and default stub**

```ts
export interface ReadingApi {
  generateFirstRound(input: StartReadingInput): Promise<GeneratedRound>;
  summarizeRound(input: SummarizeRoundInput): Promise<RoundSummaryResult>;
  generateNextRound(input: GenerateNextRoundInput): Promise<GeneratedRound>;
}

export const readingApi: ReadingApi = {
  async generateFirstRound() {
    throw new Error("Reading API not implemented");
  },
  async summarizeRound() {
    throw new Error("Reading API not implemented");
  },
  async generateNextRound() {
    throw new Error("Reading API not implemented");
  },
};
```

- [ ] **Step 4: Re-run the focused hook test and verify the contract is usable**

Run: `npm test -- packages/web/test/hooks/use-reading-session.test.tsx -t "starts a session from adapter-provided first-round data"`
Expected: still FAIL until the hook is wired in the next task, but the import/type errors are gone.

### Task 5: Implement a concrete frontend adapter for the v1 flow

**Files:**

- Modify: `packages/web/src/lib/reading-api.ts`
- Modify: `packages/web/test/hooks/use-reading-session.test.tsx`

- [ ] **Step 1: Add a failing test that the default adapter is callable and bounded**

```tsx
it("returns bounded first-round and summary outputs from the default adapter", async () => {
  const firstRound = await readingApi.generateFirstRound({ text: seededLongText });
  const summary = await readingApi.summarizeRound(seedSummaryInput());

  expect(firstRound.items.length).toBeGreaterThan(0);
  expect(firstRound.items.length).toBeLessThanOrEqual(18);
  expect(summary.missingTopics.length).toBeGreaterThanOrEqual(3);
  expect(summary.missingTopics.length).toBeLessThanOrEqual(5);
});
```

- [ ] **Step 2: Run the focused adapter test and verify it fails**

Run: `npm test -- packages/web/test/hooks/use-reading-session.test.tsx -t "returns bounded first-round and summary outputs from the default adapter"`
Expected: FAIL because the default adapter currently throws.

- [ ] **Step 3: Implement a concrete `readingApi` for v1**

```ts
export const readingApi: ReadingApi = {
  async generateFirstRound(input) {
    return buildDeterministicRoundFromText(input.text);
  },
  async summarizeRound(input) {
    return buildDeterministicSummary(input);
  },
  async generateNextRound(input) {
    return buildDeterministicNextRound(input);
  },
};
```

Implementation notes:

- If a real backend reading API already exists, wire the adapter to it now.
- If it does not exist, implement a deterministic local adapter that produces runnable non-throwing first-round items, summary data, and next-round items from the current text/session input.
- Keep the adapter contract unchanged so swapping to a backend later does not force hook/page rewrites.
- The concrete adapter must still honor the design contract: use the full input text, do not replace full-text extraction with summary-only shortcuts, dedupe before round composition, preserve review-item priority for next-round generation, and emit at most `18` current-round items plus `3-5` missing-topic suggestions.

Required helper signatures for the local implementation:

```ts
function buildDeterministicRoundFromText(text: string): GeneratedRound;
function buildDeterministicSummary(input: SummarizeRoundInput): RoundSummaryResult;
function buildDeterministicNextRound(input: GenerateNextRoundInput): GeneratedRound;
```

Required acceptance checks for those helpers:

- `buildDeterministicRoundFromText()` consumes the full `text` string and returns grouped items plus deferred pool items.
- `buildDeterministicSummary()` returns covered topics plus `3-5` missing-topic suggestions.
- `buildDeterministicNextRound()` returns review-priority items first, then new items, using the same cap rules as the spec.

- [ ] **Step 4: Re-run the focused adapter test and verify it passes**

Run: `npm test -- packages/web/test/hooks/use-reading-session.test.tsx -t "returns bounded first-round and summary outputs from the default adapter"`
Expected: PASS

## Chunk 3: Session Lifecycle Hook

### Task 6: Implement restore/save, TTL, and no-side-effects-before-submit

**Files:**

- Create: `packages/web/test/hooks/use-reading-session.test.tsx`
- Create: `packages/web/src/hooks/use-reading-session.ts`
- Modify: `packages/web/src/lib/reading-session.ts`
- Modify: `packages/web/src/lib/reading-api.ts`

- [ ] **Step 1: Write failing hook tests for persistence and submit semantics**

```tsx
it("restores an unfinished session including queues and correction hints", () => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seedSessionWithQueues()));
  const { result } = renderHook(() => useReadingSession({ readingApi: seededReadingApi() }));

  expect(result.current.session?.currentRound.items[0].correctionHint).toBe(
    "focus on the exception",
  );
  expect(result.current.session?.reviewQueue).toHaveLength(2);
  expect(result.current.session?.candidatePool).toHaveLength(4);
});

it("restores summary selections and free-text focus", () => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seedSummaryStageSession()));
  const { result } = renderHook(() => useReadingSession({ readingApi: seededReadingApi() }));

  expect(result.current.session?.summary.selectedMissingTopics).toEqual(["边界条件"]);
  expect(result.current.session?.summary.extraFocus).toBe("如何处理长期冲突");
});

it("drops expired sessions older than 24 hours", () => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seedExpiredSession()));
  const { result } = renderHook(() => useReadingSession({ readingApi: seededReadingApi() }));
  expect(result.current.session).toBeNull();
});

it("does not persist or enqueue anything before submit", async () => {
  const persistApproved = vi.fn();
  const readingApi = seededReadingApi();
  const { result } = renderHook(() => useReadingSession({ readingApi, persistApproved }));

  await act(async () => {
    await result.current.startSession({ text: seededLongText });
  });

  act(() => result.current.selectItem("item-1", "approved"));
  act(() => result.current.selectItem("item-2", "question_invalid"));
  act(() => result.current.selectItem("item-3", "answer_invalid"));
  act(() => result.current.setCorrectionHint("item-3", "lean toward commitment over preference"));

  expect(persistApproved).not.toHaveBeenCalled();
  expect(readingApi.summarizeRound).not.toHaveBeenCalled();
  expect(result.current.session?.reviewQueue).toHaveLength(0);
});
```

- [ ] **Step 2: Run the hook test file and verify it fails**

Run: `npm test -- packages/web/test/hooks/use-reading-session.test.tsx`
Expected: FAIL because the hook does not exist yet.

- [ ] **Step 3: Implement storage-backed session lifecycle and guarded submit**

```ts
export function useReadingSession(deps: UseReadingSessionDeps = {}) {
  const api = deps.readingApi ?? readingApi;
  const [session, setSession] = useState<ReadingSession | null>(() => restoreReadingSession());

  const startSession = async ({ text }: StartReadingInput) => {
    const generated = await api.generateFirstRound({ text });
    setSession(createReadingSession(text, generated));
  };

  const submitRound = async () => {
    // reject when unanswered items remain
    // split approved / invalid-question / invalid-answer
    // persist approved only here
    // summarize the round only here
    // enqueue answer-invalid items only here
  };

  return {
    session,
    startSession,
    selectItem,
    setCorrectionHint,
    submitRound,
    continueToNextRound,
    closeSession,
  };
}
```

- [ ] **Step 4: Re-run the hook test file and verify it passes**

Run: `npm test -- packages/web/test/hooks/use-reading-session.test.tsx`
Expected: PASS

### Task 7: Add summary generation, next-round wiring, and close semantics

**Files:**

- Modify: `packages/web/test/hooks/use-reading-session.test.tsx`
- Modify: `packages/web/src/hooks/use-reading-session.ts`

- [ ] **Step 1: Add failing hook tests for summary and close behavior**

```tsx
it("passes selected missing topics and free text into next-round generation", async () => {
  const readingApi = seededReadingApi();
  const { result } = renderHook(() => useReadingSession({ readingApi }));
  act(() => result.current.hydrate(seedSummaryStageSession()));

  act(() => result.current.toggleMissingTopic("边界条件"));
  act(() => result.current.setExtraFocus("如何处理长期冲突"));

  await act(async () => {
    await result.current.continueToNextRound();
  });

  expect(readingApi.generateNextRound).toHaveBeenCalledWith(
    expect.objectContaining({
      selectedMissingTopics: ["边界条件"],
      extraFocus: "如何处理长期冲突",
    }),
  );
});

it("marks the session closed and prevents auto-resume into a new round", () => {
  const { result } = renderHook(() => useReadingSession({ readingApi: seededReadingApi() }));
  act(() => result.current.hydrate(seedSummaryStageSession()));
  act(() => result.current.closeSession());

  expect(result.current.session?.status).toBe("closed");
  expect(result.current.session?.stage).toBe("closed");
});

it("keeps a persisted closed session closed after reload", () => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seedClosedSession()));
  const { result } = renderHook(() => useReadingSession({ readingApi: seededReadingApi() }));

  expect(result.current.session?.status).toBe("closed");
  expect(result.current.session?.stage).toBe("closed");
});
```

- [ ] **Step 2: Run the focused hook tests and verify they fail**

Run: `npm test -- packages/web/test/hooks/use-reading-session.test.tsx -t "passes selected missing topics and free text into next-round generation|marks the session closed and prevents auto-resume into a new round"`
Expected: FAIL

- [ ] **Step 3: Implement summary-stage controls in the hook**

```ts
const continueToNextRound = async () => {
  // call generateNextRound with summary selections and extraFocus
  // rebuild currentRound from reviewQueue-first composition
};

const closeSession = () => {
  setSession((current) => markSessionClosed(current));
};
```

- [ ] **Step 4: Re-run the focused hook tests and verify they pass**

Run: `npm test -- packages/web/test/hooks/use-reading-session.test.tsx -t "passes selected missing topics and free text into next-round generation|marks the session closed and prevents auto-resume into a new round"`
Expected: PASS

## Chunk 4: Reading Page UI

### Task 8: Build input-boundary UI before the happy path questionnaire

**Files:**

- Create: `packages/web/test/pages/ReadingPage.test.tsx`
- Create: `packages/web/src/pages/ReadingPage.tsx`
- Modify: `packages/web/public/locales/zh/translation.json`
- Modify: `packages/web/public/locales/en/translation.json`

- [ ] **Step 1: Write failing page tests for the input bounds**

```tsx
it("shows a soft warning below 800 chars but still allows start", async () => {
  const user = userEvent.setup();
  renderWithProviders(<ReadingPage />, { route: "/read" });

  await user.type(screen.getByLabelText(/长文本|Long text/i), "a".repeat(799));

  expect(screen.getByText(/这段文本有点短|This text is a bit short/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /开始阅读|Start reading/i })).toBeEnabled();
});

it("blocks start above 50000 chars", async () => {
  const user = userEvent.setup();
  renderWithProviders(<ReadingPage />, { route: "/read" });

  await user.type(screen.getByLabelText(/长文本|Long text/i), "a".repeat(50001));

  expect(screen.getByText(/50000 字以内|50000 characters or fewer/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /开始阅读|Start reading/i })).toBeDisabled();
});
```

- [ ] **Step 2: Run the boundary tests and verify they fail**

Run: `npm test -- packages/web/test/pages/ReadingPage.test.tsx -t "shows a soft warning below 800 chars but still allows start|blocks start above 50000 chars"`
Expected: FAIL because the page does not exist yet.

- [ ] **Step 3: Implement the input form and boundary copy**

```tsx
const charCount = countReadingChars(text);
const isTooLong = charCount > READING_MAX_LENGTH;
const showShortHint = text.length > 0 && charCount < READING_MIN_LENGTH_HINT;

<Textarea aria-label={t("reading.inputLabel")} ... />
<Button disabled={isTooLong || isStarting}>{t("reading.start")}</Button>
```

- [ ] **Step 4: Add boundary and page copy in both locales**

```json
"reading": {
  "title": "阅读",
  "inputLabel": "长文本",
  "start": "开始阅读",
  "shortHint": "这段文本有点短，可能提炼不出足够稳定的灵魂锚点，你也可以继续试试。",
  "tooLong": "这段文本太长了。为保证阅读效果，请压缩到 50000 字以内再试。"
}
```

- [ ] **Step 5: Re-run the boundary tests and verify they pass**

Run: `npm test -- packages/web/test/pages/ReadingPage.test.tsx -t "shows a soft warning below 800 chars but still allows start|blocks start above 50000 chars"`
Expected: PASS

### Task 9: Add questionnaire rendering and full-round submit gating

**Files:**

- Modify: `packages/web/test/pages/ReadingPage.test.tsx`
- Modify: `packages/web/src/pages/ReadingPage.tsx`
- Modify: `packages/web/public/locales/zh/translation.json`
- Modify: `packages/web/public/locales/en/translation.json`

- [ ] **Step 1: Write failing page tests for questionnaire gating**

```tsx
it("blocks round submission until every questionnaire item is answered", async () => {
  const user = userEvent.setup();
  renderWithProviders(<ReadingPage />, { route: "/read" });

  await user.type(screen.getByLabelText(/长文本|Long text/i), seededLongText);
  await user.click(screen.getByRole("button", { name: /开始阅读|Start reading/i }));

  expect(screen.getByRole("button", { name: /提交本轮|Submit round/i })).toBeDisabled();
  expect(screen.getByText(/已完成 0/i)).toBeInTheDocument();
});

it("enables submission only after all visible items are answered", async () => {
  const user = userEvent.setup();
  renderWithProviders(<ReadingPage />, { route: "/read" });

  await user.type(screen.getByLabelText(/长文本|Long text/i), seededLongText);
  await user.click(screen.getByRole("button", { name: /开始阅读|Start reading/i }));
  await answerAllVisibleItems(user);

  expect(screen.getByRole("button", { name: /提交本轮|Submit round/i })).toBeEnabled();
});
```

- [ ] **Step 2: Run the focused questionnaire tests and verify they fail**

Run: `npm test -- packages/web/test/pages/ReadingPage.test.tsx -t "blocks round submission until every questionnaire item is answered|enables submission only after all visible items are answered"`
Expected: FAIL

- [ ] **Step 3: Implement questionnaire rendering with three-state controls**

```tsx
{session.currentRound.items.map((item) => (
  <section key={item.id}>
    <h2>{item.question}</h2>
    <p>{item.answer}</p>
    <RadioGroup ...>
      <RadioGroupItem value="approved" />
      <RadioGroupItem value="question_invalid" />
      <RadioGroupItem value="answer_invalid" />
    </RadioGroup>
  </section>
))}
```

- [ ] **Step 4: Re-run the focused questionnaire tests and verify they pass**

Run: `npm test -- packages/web/test/pages/ReadingPage.test.tsx -t "blocks round submission until every questionnaire item is answered|enables submission only after all visible items are answered"`
Expected: PASS

### Task 10: Add correction hints and raw-text expansion fallback

**Files:**

- Modify: `packages/web/test/pages/ReadingPage.test.tsx`
- Modify: `packages/web/src/pages/ReadingPage.tsx`

- [ ] **Step 1: Add a failing page test for answer-invalid correction hints**

```tsx
it("shows a correction hint field only for answer-invalid items", async () => {
  const user = userEvent.setup();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seedQuestionnaireSession()));
  renderWithProviders(<ReadingPage />, { route: "/read" });

  await user.click(screen.getByRole("radio", { name: /答案不对|Answer is wrong/i }));

  expect(screen.getByPlaceholderText(/偏差在哪|What is off/i)).toBeInTheDocument();
});

it("shows a single source snippet when available and degrades locally when it is missing", async () => {
  const user = userEvent.setup();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seedQuestionnaireSession()));
  renderWithProviders(<ReadingPage />, { route: "/read" });

  await user.click(screen.getByRole("button", { name: /查看原文|View source/i }));

  expect(screen.getByText(/source snippet/i)).toBeInTheDocument();
  expect(
    screen.queryByText(/暂时无法定位片段|Could not locate a source snippet/i),
  ).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused correction-hint test and verify it fails**

Run: `npm test -- packages/web/test/pages/ReadingPage.test.tsx -t "shows a correction hint field only for answer-invalid items"`
Expected: FAIL

- [ ] **Step 3: Implement correction-hint and raw-text toggle UI**

```tsx
{
  item.selection === "answer_invalid" ? (
    <Textarea
      value={item.correctionHint ?? ""}
      onChange={(event) => reading.setCorrectionHint(item.id, event.target.value)}
      placeholder={t("reading.correctionHintPlaceholder")}
    />
  ) : null;
}

<Button type="button" variant="ghost" onClick={() => reading.toggleSource(item.id)}>
  {t("reading.viewSource")}
</Button>;

{
  item.isSourceOpen ? (
    item.sourceSnippet ? (
      <p>{item.sourceSnippet}</p>
    ) : (
      <p>{t("reading.sourceUnavailable")}</p>
    )
  ) : null;
}
```

- [ ] **Step 4: Re-run the focused correction-hint test and verify it passes**

Run: `npm test -- packages/web/test/pages/ReadingPage.test.tsx -t "shows a correction hint field only for answer-invalid items"`
Expected: PASS

### Task 11: Add summary interactions, next-round controls, and close flow

**Files:**

- Modify: `packages/web/test/pages/ReadingPage.test.tsx`
- Modify: `packages/web/src/pages/ReadingPage.tsx`
- Modify: `packages/web/public/locales/zh/translation.json`
- Modify: `packages/web/public/locales/en/translation.json`

- [ ] **Step 1: Write failing page tests for summary and close interactions**

```tsx
it("shows covered topics, 3-5 missing-topic suggestions, and free-text focus after submit", async () => {
  const user = userEvent.setup();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seedQuestionnaireSession()));
  renderWithProviders(<ReadingPage />, { route: "/read" });

  await answerAllVisibleItems(user);
  await user.click(screen.getByRole("button", { name: /提交本轮|Submit round/i }));

  expect(await screen.findByText(/已覆盖主题|Covered topics/i)).toBeInTheDocument();
  const suggestionButtons = screen.getAllByRole("button", {
    name: /边界条件|Boundaries|长期关系|Long-term relationships|冲突处理|Conflict handling/i,
  });
  expect(suggestionButtons.length).toBeGreaterThanOrEqual(3);
  expect(suggestionButtons.length).toBeLessThanOrEqual(5);
  expect(screen.getByLabelText(/补充关注点|Add focus/i)).toBeInTheDocument();
});

it("closes the session when the user chooses already enough", async () => {
  const user = userEvent.setup();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seedSummaryStageSession()));
  renderWithProviders(<ReadingPage />, { route: "/read" });

  await user.click(screen.getByRole("button", { name: /已经足够|Already enough/i }));

  expect(screen.getByText(/本次阅读已结束|Reading session closed/i)).toBeInTheDocument();
});

it("renders theme group headings and a review badge for review-queue items", () => {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(seedQuestionnaireSessionWithReviewItems()),
  );
  renderWithProviders(<ReadingPage />, { route: "/read" });

  expect(screen.getByText(/价值观判断|Value judgments/i)).toBeInTheDocument();
  expect(screen.getByText(/答案待修正|Answer needs revision/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused summary tests and verify they fail**

Run: `npm test -- packages/web/test/pages/ReadingPage.test.tsx -t "shows covered topics, 3-5 missing-topic suggestions, and free-text focus after submit|closes the session when the user chooses already enough"`
Expected: FAIL

- [ ] **Step 3: Implement summary-stage controls and closed-state UI**

Also ensure questionnaire rendering preserves two spec-visible cues that must not be skipped:

- theme group headings above grouped items
- a lightweight review badge on items sourced from the review queue

```tsx
<Button onClick={() => void reading.continueToNextRound()}>{t("reading.keepDigging")}</Button>
<Button variant="secondary" onClick={() => reading.closeSession()}>{t("reading.alreadyEnough")}</Button>
```

- [ ] **Step 4: Re-run the focused summary tests and verify they pass**

Run: `npm test -- packages/web/test/pages/ReadingPage.test.tsx -t "shows covered topics, 3-5 missing-topic suggestions, and free-text focus after submit|closes the session when the user chooses already enough"`
Expected: PASS

## Chunk 5: Verification Sweep

### Task 12: Run the focused reading-flow verification suite

**Files:**

- Test: `packages/web/test/pages/App.test.tsx`
- Test: `packages/web/test/pages/DiscoverPage.test.tsx`
- Test: `packages/web/test/pages/ReadingPage.test.tsx`
- Test: `packages/web/test/hooks/use-reading-session.test.tsx`
- Test: `packages/web/test/lib/reading-session.test.ts`

- [ ] **Step 1: Run all focused reading-flow tests**

Run: `npm test -- packages/web/test/pages/App.test.tsx packages/web/test/pages/DiscoverPage.test.tsx packages/web/test/pages/ReadingPage.test.tsx packages/web/test/hooks/use-reading-session.test.tsx packages/web/test/lib/reading-session.test.ts`
Expected: PASS

- [ ] **Step 2: Run the broader web suite if the focused tests pass**

Run: `npm test -- packages/web/test/pages packages/web/test/hooks packages/web/test/lib`
Expected: PASS

- [ ] **Step 3: Manually verify the flow in the browser**

Run: `npm run dev`
Expected: Discover shows the `阅读` entry, `/read` loads, short input warns, too-long input blocks, unanswered items block submission, submit advances to summary, continue uses summary selections, and refresh restores unfinished work within the TTL.

## Plan Review Notes

- Keep v1 frontend-scoped unless a real backend reading API already exists.
- If the backend API does not exist yet, keep `packages/web/src/lib/reading-api.ts` as the stable seam and inject deterministic mocks in tests.
- Do not collapse the helper, adapter, hook, and page into one file; the questionnaire semantics are too easy to regress without isolated tests.

## Plan Complete Criteria

- Discover exposes the `阅读` entry.
- `/read` renders as a standalone page.
- The flow behaves like a questionnaire, not an auto-save reviewer.
- Submission is impossible until all current-round items are answered.
- `认可` items only persist on round submit.
- `问题不对` and `答案不对` produce no pre-submit side effects.
- Summary shows covered topics, 3-5 missing-topic suggestions, and free-text focus.
- Continue/close behavior respects the approved session rules.
- Session recovery works for unfinished rounds within the 24-hour TTL.
