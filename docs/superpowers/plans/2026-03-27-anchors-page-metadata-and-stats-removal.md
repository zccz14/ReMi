# Anchors Page Metadata And Stats Removal Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show anchor total plus created/updated timestamps on the anchors page, sort anchors by `updatedAt` descending, and fully remove the standalone stats page.

**Architecture:** Keep the data flow centered on the existing anchors list API. Update the server route to return anchors in `updatedAt desc, createdAt desc` order, extend the existing `useAnchors()` hook to expose `total`, and let `AnchorsPage` render the new summary and timestamp metadata. Remove the obsolete stats page from routes, menu entries, tests, and mocks instead of redirecting or hiding it.

**Tech Stack:** TypeScript, React, React Router, i18next, Hono, Drizzle ORM, Vitest, Testing Library

**Status:** Approved for implementation

---

## File Map

- Modify: `packages/server/src/routes/anchors.ts` — change server-side list ordering to `updatedAt` first while preserving stable tie-breaking.
- Modify: `packages/server/test/routes/anchors.test.ts` — add route coverage for updated-time ordering after editing an older anchor.
- Modify: `packages/web/src/hooks/use-anchors.ts` — store and return `total` alongside `anchors`.
- Modify: `packages/web/test/hooks/use-anchors.test.ts` — verify `total` is loaded and refreshed with CRUD reloads.
- Modify: `packages/web/src/pages/AnchorsPage.tsx` — render total count, created/updated timestamps, and timestamp formatting fallback.
- Modify: `packages/web/public/locales/zh/translation.json` — add anchor total and timestamp labels, remove obsolete `me.stats` if it becomes unused.
- Modify: `packages/web/public/locales/en/translation.json` — add matching English anchor labels, remove obsolete `me.stats` if it becomes unused.
- Modify: `packages/web/test/pages/AnchorsPage.test.tsx` — cover total rendering, timestamps, and search-total semantics.
- Modify: `packages/web/src/pages/MePage.tsx` — drop the stats menu item and related icon import.
- Modify: `packages/web/src/App.tsx` — remove the `/stats` route and `StatsPage` import.
- Delete: `packages/web/src/pages/StatsPage.tsx` — remove the obsolete page implementation.
- Delete: `packages/web/test/pages/StatsPage.test.tsx` — remove page-specific tests for the deleted screen.
- Modify: `packages/web/test/pages/App.test.tsx` — remove `StatsPage` route mock.
- Modify: `packages/web/test/pages/MePage.test.tsx` — verify the me menu no longer contains a stats entry.

## Chunk 1: Backend Ordering And Shared Anchor Data

### Task 1: Lock down anchor list ordering at the API layer

**Files:**

- Modify: `packages/server/test/routes/anchors.test.ts`
- Modify: `packages/server/src/routes/anchors.ts`

- [ ] **Step 1: Write the failing ordering test**

Add a route test like:

```ts
vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(2000).mockReturnValueOnce(3000);

it("GET /api/:pubKey/anchors orders by updatedAt desc after edits", async () => {
  const app = createTestApp(connMgr, PUB_KEY);

  const older = await app.request(`/api/${PUB_KEY}/anchors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "Older", source: "manual" }),
  });
  const newer = await app.request(`/api/${PUB_KEY}/anchors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "Newer", source: "manual" }),
  });

  const { data: olderAnchor } = await older.json();
  await app.request(`/api/${PUB_KEY}/anchors/${olderAnchor.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer: "edited later" }),
  });

  const res = await app.request(`/api/${PUB_KEY}/anchors`);
  const json = await res.json();
  expect(json.data.items.map((item: { question: string }) => item.question)).toEqual([
    "Older",
    "Newer",
  ]);
});
```

Use controlled `Date.now()` values or an equivalent deterministic clock so the POST/PUT sequence cannot collapse onto the same millisecond.

Restore the mock inside the test with `dateNowMock.mockRestore()` or an equivalent `try/finally`, because this test file does not currently do a blanket `vi.restoreAllMocks()` cleanup.

- [ ] **Step 2: Run the focused route test and confirm failure**

Run: `npx vitest run packages/server/test/routes/anchors.test.ts`
Expected: FAIL because the list endpoint still orders by `createdAt`.

- [ ] **Step 3: Implement the minimal ordering change**

Update the list query in `packages/server/src/routes/anchors.ts` from:

```ts
.orderBy(desc(soulAnchors.createdAt))
```

to:

```ts
.orderBy(desc(soulAnchors.updatedAt), desc(soulAnchors.createdAt))
```

Do not change the response shape.

- [ ] **Step 4: Re-run the route test**

Run: `npx vitest run packages/server/test/routes/anchors.test.ts`
Expected: PASS.

### Task 2: Expose anchor total through the existing hook

**Files:**

- Modify: `packages/web/test/hooks/use-anchors.test.ts`
- Modify: `packages/web/src/hooks/use-anchors.ts`

- [ ] **Step 1: Write the failing hook expectation**

Add assertions like:

```ts
expect(result.current.total).toBe(2);
```

and after a reload path:

```ts
expect(result.current.total).toBe(2);
```

Extend the mocked return contract so tests fail until the hook exposes `total`.

- [ ] **Step 2: Run the focused hook test and confirm failure**

Run: `npx vitest run packages/web/test/hooks/use-anchors.test.ts`
Expected: FAIL because `useAnchors()` currently returns no `total` field.

- [ ] **Step 3: Implement the minimal hook change**

In `packages/web/src/hooks/use-anchors.ts`:

```ts
const [total, setTotal] = useState(0);
// ...
setAnchors(res.data.items);
setTotal(res.data.total);
// ...
return { anchors, total, loading, create, update, remove, reload: load };
```

On load failure, keep `anchors` as `[]` and make sure `total` remains a safe numeric value.

- [ ] **Step 4: Re-run the hook test**

Run: `npx vitest run packages/web/test/hooks/use-anchors.test.ts`
Expected: PASS.

## Chunk 2: Anchors Page UI, I18n, And Stats Removal

### Task 3: Add timestamp and total rendering on the anchors page

**Files:**

- Modify: `packages/web/test/pages/AnchorsPage.test.tsx`
- Modify: `packages/web/public/locales/zh/translation.json`
- Modify: `packages/web/public/locales/en/translation.json`
- Modify: `packages/web/src/pages/AnchorsPage.tsx`

- [ ] **Step 1: Write failing page assertions for total and timestamps**

Extend `packages/web/test/pages/AnchorsPage.test.tsx` so the mocked hook returns `total`, then add coverage for:

```ts
expect(getByText(/总灵魂锚点/)).toBeInTheDocument();
expect(getByText(/创建于|Created/)).toBeInTheDocument();
expect(getByText(/更新于|Updated/)).toBeInTheDocument();
```

Also add a search-state assertion proving the total remains the full account total even when one item is filtered out.

- [ ] **Step 2: Run the focused page test and confirm failure**

Run: `npx vitest run packages/web/test/pages/AnchorsPage.test.tsx`
Expected: FAIL because the page renders neither total nor timestamps yet.

- [ ] **Step 3: Add the i18n keys before wiring UI**

Update translations with keys shaped like:

```json
{
  "anchors": {
    "total": "总灵魂锚点：{{count}}",
    "createdAt": "创建于 {{value}}",
    "updatedAt": "更新于 {{value}}"
  }
}
```

and matching English strings:

```json
{
  "anchors": {
    "total": "Total soul anchors: {{count}}",
    "createdAt": "Created {{value}}",
    "updatedAt": "Updated {{value}}"
  }
}
```

Keep existing anchor keys untouched.

- [ ] **Step 4: Implement minimal page rendering**

In `packages/web/src/pages/AnchorsPage.tsx`:

```ts
const { anchors, total, loading, create, update, remove } = useAnchors(apiClient);

function formatTimestamp(ts: number) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
```

Render `t("anchors.total", { count: total })` near the search input, and render both timestamp lines in each non-edit card. Keep them visible even when `createdAt === updatedAt`.

- [ ] **Step 5: Re-run the anchors page test**

Run: `npx vitest run packages/web/test/pages/AnchorsPage.test.tsx`
Expected: PASS.

### Task 4: Remove the stats page from navigation and routing

**Files:**

- Modify: `packages/web/test/pages/MePage.test.tsx`
- Modify: `packages/web/test/pages/App.test.tsx`
- Modify: `packages/web/src/pages/MePage.tsx`
- Modify: `packages/web/src/App.tsx`
- Delete: `packages/web/src/pages/StatsPage.tsx`
- Delete: `packages/web/test/pages/StatsPage.test.tsx`

- [ ] **Step 1: Write failing tests around stats removal**

Add assertions such as:

```ts
expect(screen.queryByText("数据统计")).not.toBeInTheDocument();
```

Also add a route-level assertion in `packages/web/test/pages/App.test.tsx` that drives the browser to `/stats` and proves the app no longer renders a stats page. For example, keep a `StatsPage` mock temporarily and assert it is _not_ shown when visiting `/stats`, while the router falls through to the default authenticated route.

- [ ] **Step 2: Run the affected page tests and confirm failure**

Run: `npx vitest run packages/web/test/pages/MePage.test.tsx packages/web/test/pages/App.test.tsx`
Expected: FAIL because `MePage` still includes the stats menu item and `/stats` still resolves to the stats route.

- [ ] **Step 3: Implement the minimal removal**

Make these edits:

```ts
// packages/web/src/pages/MePage.tsx
import { Anchor, Share2, Settings, ChevronRight, Download } from "lucide-react";

const menuItems = [
  { icon: Anchor, labelKey: "me.anchors", to: "/anchors" },
  { icon: Share2, labelKey: "me.share", to: "/share" },
  { icon: Settings, labelKey: "me.settings", to: "/settings" },
] as const;
```

```ts
// packages/web/src/App.tsx
// remove StatsPage import
// remove <Route path="/stats" element={<StatsPage />} />
```

Then delete the obsolete page and its dedicated test file.

- [ ] **Step 4: Re-run the affected page tests**

Run: `npx vitest run packages/web/test/pages/MePage.test.tsx packages/web/test/pages/App.test.tsx`
Expected: PASS, with no remaining import or mock references to `StatsPage` in the affected tests.

### Task 5: Run the full focused regression set for this feature

**Files:**

- Modify: none
- Test: `packages/server/test/routes/anchors.test.ts`
- Test: `packages/web/test/hooks/use-anchors.test.ts`
- Test: `packages/web/test/pages/AnchorsPage.test.tsx`
- Test: `packages/web/test/pages/MePage.test.tsx`
- Test: `packages/web/test/pages/App.test.tsx`

- [ ] **Step 1: Run the full feature test set**

Run: `npx vitest run packages/server/test/routes/anchors.test.ts packages/web/test/hooks/use-anchors.test.ts packages/web/test/pages/AnchorsPage.test.tsx packages/web/test/pages/MePage.test.tsx packages/web/test/pages/App.test.tsx`
Expected: PASS.

- [ ] **Step 2: Run one TypeScript/lint sanity check for touched frontend/backend surfaces**

Run: `npx tsc -p packages/web/tsconfig.json --noEmit && npx tsc -p packages/server/tsconfig.json --noEmit`
Expected: PASS with no new type errors in the touched frontend and backend files.

- [ ] **Step 3: Commit the finished slice**

```bash
git add packages/server/src/routes/anchors.ts packages/server/test/routes/anchors.test.ts packages/web/src/hooks/use-anchors.ts packages/web/test/hooks/use-anchors.test.ts packages/web/src/pages/AnchorsPage.tsx packages/web/test/pages/AnchorsPage.test.tsx packages/web/src/pages/MePage.tsx packages/web/test/pages/MePage.test.tsx packages/web/src/App.tsx packages/web/test/pages/App.test.tsx packages/web/public/locales/zh/translation.json packages/web/public/locales/en/translation.json packages/web/src/pages/StatsPage.tsx packages/web/test/pages/StatsPage.test.tsx
git commit -m "feat(web): enrich anchors page and remove stats screen"
```

Only perform this step if the user explicitly asks for a commit.
