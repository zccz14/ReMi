# Soul Approval Library Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a unified candidate approval pipeline and mobile-first approval center so every soul anchor/probe reaches formal storage only after owner approval.

**Architecture:** Add a server-side approval gateway that owns candidate ingestion, formal asset writes, normalization, undo, and observability. Replace direct anchor writes from manual/interview/reading flows with candidate creation, then add a web approval center at `/approval/anchors` and `/approval/probes` while keeping formal soul assets in the existing `soul_anchors` table.

**Tech Stack:** Hono, Drizzle + SQLite, React, React Router, i18next, Vitest

---

## File Map

**Server create**

- `packages/server/src/approval/normalize.ts` - shared `question` / `answer` normalization helpers and asset-kind derivation
- `packages/server/src/approval/service.ts` - approval gateway for candidate CRUD, formal writes, undo, observability hooks
- `packages/server/src/approval/source-context.ts` - source / sourceRef shaping for approval detail UI
- `packages/server/src/approval/alerts.ts` - approval rollout alert rules and validation helpers
- `packages/server/src/routes/approval.ts` - owner-only approval center APIs
- `packages/server/test/approval/service.test.ts` - unit tests for normalization, atomic approval, stale target rejection, undo
- `packages/server/test/routes/approval.test.ts` - route-level tests for candidate listing, approve/reject/skip/undo

**Server modify**

- `packages/server/src/db/schema.ts` - add candidate queue tables / last-action buffer schema definitions
- `packages/server/src/db/migrate.ts` - create new approval tables and indexes
- `packages/server/src/types.ts` - add candidate / approval payload types, including shared side-effect request contracts with `requestId`
- `packages/server/src/app.ts` - mount approval routes and inject dependencies
- `packages/server/src/routes/anchors.ts` - route all formal asset writes through approval gateway, add asset micro-edit / deny safe path
- `packages/server/src/routes/interview.ts` - replace direct `soul_anchors` inserts with candidate ingestion
- `packages/server/src/routes/reading.ts` - if server gains persistence endpoints for reading approvals, route them to candidate ingestion instead of direct writes
- `packages/server/test/routes/anchors.test.ts` - update expectations for formal write gateway behavior
- `packages/server/test/routes/interview.test.ts` - assert interview extraction creates candidates instead of formal assets

**Web create**

- `packages/web/src/lib/approval-api.ts` - typed approval center client
- `packages/web/src/hooks/use-approval-center.ts` - fetch candidates, submit swipe actions, trigger undo, manage optimistic UI
- `packages/web/src/pages/ApprovalPage.tsx` - shell page that maps route path to anchor/probe tab
- `packages/web/src/components/approval/ApprovalTabs.tsx` - tab header synced to router path
- `packages/web/src/components/approval/CandidateCard.tsx` - swipeable candidate card with semantic preview states
- `packages/web/src/components/approval/CandidateDetailSheet.tsx` - detail view for source context, micro-edit, update-existing selection
- `packages/web/test/lib/approval-api.test.ts` - approval API tests
- `packages/web/test/hooks/use-approval-center.test.ts` - hook tests for loading / submit / undo / stale conflicts
- `packages/web/test/components/CandidateCard.test.tsx` - swipe preview / action semantics tests

**Web modify**

- `packages/web/src/App.tsx` - add `/approval/anchors` and `/approval/probes` routes and default redirect
- `packages/web/src/components/layout/NavBar.tsx` - replace middle nav item with approval center entry
- `packages/web/src/pages/DiscoverPage.tsx` - demote approval entry responsibility; keep discovery scoped to reading
- `packages/web/src/pages/AnchorsPage.tsx` - keep formal asset management; add explicit soul-deny / micro-edit wording if needed
- `packages/web/src/hooks/use-anchors.ts` - adapt to any new formal asset APIs / deny endpoint
- `packages/web/src/lib/reading-api.ts` - stop direct `/anchors` persistence and send approved reading outputs into candidate ingestion
- `packages/web/public/locales/zh/translation.json` - approval center copy
- `packages/web/public/locales/en/translation.json` - approval center copy

## Chunk 1: Approval Data Boundary And Gateway

### Task 1: Add approval persistence schema

**Files:**

- Modify: `packages/server/src/db/schema.ts`
- Modify: `packages/server/src/db/migrate.ts`
- Test: `packages/server/test/db/migrate.test.ts`

- [ ] **Step 1: Write the failing migration test**

Add assertions in `packages/server/test/db/migrate.test.ts` that a fresh database now contains:

```ts
expect(listTables(db)).toEqual(
  expect.arrayContaining([
    "soul_anchors",
    "soul_candidate_queue",
    "approval_last_actions",
    "approval_requests",
  ]),
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/server/test/db/migrate.test.ts`
Expected: FAIL because the new approval tables do not exist yet.

- [ ] **Step 3: Add minimal schema and migration support**

In `packages/server/src/db/schema.ts`, add tables for:

```ts
export const soulCandidateQueue = sqliteTable("soul_candidate_queue", {
  id: text("id").primaryKey(),
  question: text("question").notNull(),
  answer: text("answer"),
  source: text("source").notNull(),
  sourceRef: text("source_ref"),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
});

export const approvalLastActions = sqliteTable("approval_last_actions", {
  ownerKey: text("owner_key").primaryKey(),
  actionId: text("action_id").notNull(),
  candidateSnapshot: text("candidate_snapshot").notNull(),
  rollbackPayload: text("rollback_payload").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
});

export const approvalRequests = sqliteTable("approval_requests", {
  id: text("id").primaryKey(),
  ownerKey: text("owner_key").notNull(),
  candidateId: text("candidate_id").notNull(),
  requestId: text("request_id").notNull(),
  action: text("action").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
});
```

Mirror the tables and indexes in `packages/server/src/db/migrate.ts`, including a unique constraint or unique index for `ownerKey + candidateId + requestId`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/server/test/db/migrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db/schema.ts packages/server/src/db/migrate.ts packages/server/test/db/migrate.test.ts
git commit -m "feat: add approval queue persistence"
```

### Task 2: Build shared normalization and asset-kind helpers

**Files:**

- Create: `packages/server/src/approval/normalize.ts`
- Modify: `packages/server/src/types.ts`
- Test: `packages/server/test/approval/service.test.ts`

- [ ] **Step 1: Write failing normalization tests**

Add tests for:

```ts
expect(normalizeQuestion("  What matters?  ")).toBe("What matters?");
expect(() => normalizeQuestion("   ")).toThrow(/question/i);
expect(normalizeAnswer("   ")).toBeNull();
expect(getSoulAssetKind({ answer: null })).toBe("probe");
expect(getSoulAssetKind({ answer: "Answer" })).toBe("anchor");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/server/test/approval/service.test.ts`
Expected: FAIL because the module does not exist yet.

- [ ] **Step 3: Implement normalization helpers**

Create `packages/server/src/approval/normalize.ts` with helpers like:

```ts
export function normalizeQuestion(input: string): string {
  /* trim + reject blank */
}
export function normalizeAnswer(input: string | null | undefined): string | null {
  /* trim -> null */
}
export function getSoulAssetKind(input: { answer: string | null }): "anchor" | "probe" {
  /* ... */
}
```

Export matching shared types from `packages/server/src/types.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/server/test/approval/service.test.ts`
Expected: PASS for normalization cases.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/approval/normalize.ts packages/server/src/types.ts packages/server/test/approval/service.test.ts
git commit -m "feat: normalize soul approval payloads"
```

### Task 2b: Expand formal asset source enums for new producers

**Files:**

- Modify: `packages/server/src/db/schema.ts`
- Modify: `packages/server/src/db/migrate.ts`
- Modify: `packages/server/src/types.ts`
- Test: `packages/server/test/routes/anchors.test.ts`

- [ ] **Step 1: Write the failing source contract test**

Add coverage that a formal asset approved from reading can persist and round-trip with `source: "reading"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/server/test/routes/anchors.test.ts`
Expected: FAIL because the formal asset source enum still only accepts `interview | manual`.

- [ ] **Step 3: Extend the shared source contract**

Update the formal asset schema, migration SQL, and `SoulAnchor` type so producer provenance can include `reading`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/server/test/routes/anchors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db/schema.ts packages/server/src/db/migrate.ts packages/server/src/types.ts packages/server/test/routes/anchors.test.ts
git commit -m "feat: keep reading provenance on formal assets"
```

### Task 3a: Implement candidate ingestion and source context

**Files:**

- Create: `packages/server/src/approval/service.ts`
- Create: `packages/server/src/approval/source-context.ts`
- Test: `packages/server/test/approval/service.test.ts`

- [ ] **Step 1: Write failing service tests**

Cover these cases in `packages/server/test/approval/service.test.ts`:

```ts
it("creates candidates through a shared ingestion API", async () => {
  /* ... */
});
it("stores display-ready source context for interview and reading candidates", async () => {
  /* ... */
});
it("lists anchor/probe candidates by normalized answer kind", async () => {
  /* ... */
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/server/test/approval/service.test.ts`
Expected: FAIL because ingestion and source-context handling are not implemented.

- [ ] **Step 3: Implement candidate ingestion and context shaping**

Add a gateway API with methods such as:

```ts
createCandidate(input);
listCandidates({ kind, limit, offset });
```

Implementation rules:

- normalize every write through the shared helpers
- define one minimal source-context strategy for detail UI; recommended first pass is serialized display snapshot plus `sourceRef`

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/server/test/approval/service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/approval/service.ts packages/server/src/approval/source-context.ts packages/server/test/approval/service.test.ts
git commit -m "feat: add approval candidate ingestion"
```

### Task 3b: Implement atomic approve/reject flows with OCC and embedding sync

**Files:**

- Modify: `packages/server/src/approval/service.ts`
- Modify: `packages/server/src/db/schema.ts`
- Modify: `packages/server/src/db/migrate.ts`
- Test: `packages/server/test/approval/service.test.ts`

- [ ] **Step 1: Extend service tests for formal writes**

Cover these cases in `packages/server/test/approval/service.test.ts`:

```ts
it("approves candidate into formal asset and deletes candidate atomically", async () => {
  /* ... */
});
it("rejects stale update_existing requests and keeps candidate pending", async () => {
  /* ... */
});
it("routes deny to answer=null and recalculates kind as probe", async () => {
  /* ... */
});
it("keeps soul_anchors_vec in sync for create/update/deny", async () => {
  /* ... */
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/server/test/approval/service.test.ts`
Expected: FAIL because formal write flows are incomplete.

- [ ] **Step 3: Implement atomic approval flows**

Add service methods such as:

```ts
approveCandidate({ candidateId, action, mode, targetAssetId, targetUpdatedAt, requestId })
microEditAsset(...)
denyAsset(...)
```

Implementation rules:

- use one transaction for formal write + candidate delete + last_action update
- require `targetUpdatedAt` for `update_existing`
- reject stale target updates without consuming the candidate
- make the gateway own `soul_anchors_vec` sync for create / update / deny / rollback-sensitive paths
- extend formal asset source handling to keep producer provenance (`interview`, `manual`, `reading`) instead of collapsing reading to `manual`

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/server/test/approval/service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/approval/service.ts packages/server/src/db/schema.ts packages/server/src/db/migrate.ts packages/server/test/approval/service.test.ts
git commit -m "feat: add atomic approval writes"
```

### Task 3c: Implement idempotency and undo

**Files:**

- Modify: `packages/server/src/approval/service.ts`
- Modify: `packages/server/src/db/schema.ts`
- Modify: `packages/server/src/db/migrate.ts`
- Test: `packages/server/test/approval/service.test.ts`

- [ ] **Step 1: Extend service tests for idempotency and undo**

Cover these cases in `packages/server/test/approval/service.test.ts`:

```ts
it("dedupes candidateId + requestId via approval_requests", async () => {
  /* ... */
});
it("stores one last_action per owner and restores candidate on undo", async () => {
  /* ... */
});
it("resyncs vectors on undo rollback", async () => {
  /* ... */
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/server/test/approval/service.test.ts`
Expected: FAIL because idempotency and undo rollback are incomplete.

- [ ] **Step 3: Implement idempotency and undo**

Persist `ownerKey + candidateId + requestId` dedupe state in `approval_requests`. Make `undoLastAction()` restore the candidate, revert the formal asset mutation, and resync embeddings.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/server/test/approval/service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/approval/service.ts packages/server/src/db/schema.ts packages/server/src/db/migrate.ts packages/server/test/approval/service.test.ts
git commit -m "feat: add approval undo and idempotency"
```

## Chunk 2: Server Routes And Producer Migration

### Task 4: Expose approval APIs

**Files:**

- Create: `packages/server/src/routes/approval.ts`
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/test/routes/approval.test.ts`

- [ ] **Step 1: Write failing route tests**

Add route tests for:

```ts
POST /api/:pubKey/approval/candidates
GET /api/:pubKey/approval/candidates?kind=anchor
GET /api/:pubKey/approval/candidates?kind=probe
POST /api/:pubKey/approval/candidates/:id/approve   // requires requestId
POST /api/:pubKey/approval/candidates/:id/reject    // requires requestId
POST /api/:pubKey/approval/candidates/:id/skip      // requires requestId
POST /api/:pubKey/approval/undo                     // requires actionId
PUT /api/:pubKey/anchors/:id                        // micro-edit requires requestId
POST /api/:pubKey/anchors/:id/deny                 // deny requires requestId
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/server/test/routes/approval.test.ts`
Expected: FAIL because the route file is missing.

- [ ] **Step 3: Implement owner-only approval routes**

Expose thin Hono handlers that call the approval service and return typed responses. Minimum producer-ingress contract:

```ts
POST /api/:pubKey/approval/candidates
{ question, answer?, source, sourceRef?, sourceSnapshot? }

type ApprovalMutationRequest = {
  requestId: string;
};
```

This endpoint becomes the shared ingestion path for manual, reading, interview, and future producers. All side-effecting approval actions must use the shared API contract and carry `requestId` so the server can enforce `ownerKey + candidateId + requestId` idempotency. Candidate list/detail responses must also return web-ready provenance fields: `source`, `sourceRef`, and `sourceSnapshot` (or equivalent display context). Mount the route from `packages/server/src/app.ts` next to existing business routes.

Hard rule: every client request that can mutate formal assets must include `requestId`, including `approve`, `reject`, `skip`, `update_existing`, `micro_edit`, and `deny`. `undo` continues to use `actionId` because it targets the prior committed action rather than minting a new idempotent mutation.

Server-side rule: every gateway-backed mutation handler must validate `requestId` presence before calling the service. Missing `requestId` must return a 4xx response; the server must not silently mint one on behalf of the client.

Route error contract to test and keep uniform:

- missing `requestId` -> `400`
- candidate already processed -> `409`
- stale target / `updatedAt` mismatch -> `409`
- undo conflict / target changed -> `409`
- candidate or asset not found -> `404`
- disabled legacy delete path -> `405`

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/server/test/routes/approval.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/approval.ts packages/server/src/app.ts packages/server/test/routes/approval.test.ts
git commit -m "feat: add approval center api routes"
```

### Task 5: Stop direct formal writes from manual anchor management

**Files:**

- Modify: `packages/server/src/routes/anchors.ts`
- Test: `packages/server/test/routes/anchors.test.ts`

- [ ] **Step 1: Write failing route tests for manual create behavior**

Update tests so `POST /api/:pubKey/anchors` now expects a candidate response or a formal write through the gateway instead of a direct insert path. Add a deny-focused test for formal asset mutation if you add `POST /api/:pubKey/anchors/:id/deny`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/server/test/routes/anchors.test.ts`
Expected: FAIL because the route still inserts directly into `soul_anchors`.

- [ ] **Step 3: Rewire anchor routes**

Change the route behavior to:

- treat `POST /anchors` as “create manual candidate” rather than direct formal write
- keep `GET /anchors` as formal asset listing
- keep `PUT /anchors/:id` as formal asset micro-edit, but force it through the unified approval gateway
- add an explicit asset deny path if needed (`answer -> null`) through the same gateway

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/server/test/routes/anchors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/anchors.ts packages/server/test/routes/anchors.test.ts
git commit -m "refactor: route anchor writes through approval gateway"
```

### Task 5b: Close the remaining formal-asset write paths

**Files:**

- Modify: `packages/server/src/routes/anchors.ts`
- Test: `packages/server/test/routes/anchors.test.ts`

- [ ] **Step 1: Write failing tests for delete behavior**

Add route tests that force an explicit decision for:

- `DELETE /api/:pubKey/anchors/:id`
- `DELETE /api/:pubKey/anchors`

The acceptable first pass is either “route through the gateway” or “return a deliberate disabled/error response”, but not direct table mutation.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/server/test/routes/anchors.test.ts`
Expected: FAIL because delete paths still mutate `soul_anchors` directly.

- [ ] **Step 3: Remove direct delete writes**

Implement the chosen strategy and make sure `packages/server/src/routes/anchors.ts` no longer performs raw `delete(soulAnchors)` writes outside the gateway.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/server/test/routes/anchors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/anchors.ts packages/server/test/routes/anchors.test.ts
git commit -m "refactor: close remaining formal asset write paths"
```

### Task 6: Stop direct formal writes from interview and reading flows

**Files:**

- Modify: `packages/server/src/routes/interview.ts`
- Modify: `packages/web/src/lib/reading-api.ts`
- Test: `packages/server/test/routes/interview.test.ts`
- Test: `packages/web/test/lib/reading-api.test.ts`

- [ ] **Step 1: Write failing tests for candidate ingestion**

Add tests that assert interview extraction and reading approval now create approval candidates instead of posting directly to `/anchors`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- packages/server/test/routes/interview.test.ts packages/web/test/lib/reading-api.test.ts`
Expected: FAIL because both flows still assume direct anchor persistence.

- [ ] **Step 3: Migrate producers**

Implementation targets:

- replace `saveAnchors()` in `packages/server/src/routes/interview.ts` with candidate creation through the approval service
- replace `persistReadingApprovedAnchors()` in `packages/web/src/lib/reading-api.ts` to call the approval candidate ingestion endpoint
- preserve `source` / `sourceRef` so approval detail can show origin context
- add explicit assertions for source mapping so approved reading candidates keep `source: "reading"` in formal assets once approved

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- packages/server/test/routes/interview.test.ts packages/web/test/lib/reading-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/interview.ts packages/web/src/lib/reading-api.ts packages/server/test/routes/interview.test.ts packages/web/test/lib/reading-api.test.ts
git commit -m "refactor: send interview and reading outputs to approval queue"
```

## Chunk 3: Web Approval Center

### Task 7: Add approval API client and state hook

**Files:**

- Create: `packages/web/src/lib/approval-api.ts`
- Create: `packages/web/src/hooks/use-approval-center.ts`
- Test: `packages/web/test/lib/approval-api.test.ts`
- Test: `packages/web/test/hooks/use-approval-center.test.ts`

- [ ] **Step 1: Write failing API and hook tests**

Cover:

```ts
expect(api.listCandidates("anchor")).toCallPath("/approval/candidates?kind=anchor");
expect(api.approveCandidate({ requestId: "req-1", ... })).toPOST(...);
expect(api.rejectCandidate({ requestId: "req-1", ... })).toPOST(...);
expect(api.skipCandidate({ requestId: "req-1", ... })).toPOST(...);
expect(api.undo({ actionId: "action-1" })).toPOST(...);
expect(api.listCandidates("anchor").data.items[0].sourceSnapshot).toEqual(expect.anything());
expect(hook.current.candidates).toEqual(expectedItems);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/web/test/lib/approval-api.test.ts packages/web/test/hooks/use-approval-center.test.ts`
Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement minimal client and hook**

The hook should:

- load candidates by current kind
- expose swipe actions (`approve`, `keepQuestionOnly`, `reject`, `skipProbe`, `undo`)
- keep `lastActionId` for down-swipe undo
- mint or attach stable `requestId` values for every side-effecting submission
- reopen the candidate when server rejects stale target updates
- treat `requestId` generation as a client responsibility: mint a fresh id per user-intended mutation, keep it stable across retries of that mutation, and never silently omit it

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/web/test/lib/approval-api.test.ts packages/web/test/hooks/use-approval-center.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/approval-api.ts packages/web/src/hooks/use-approval-center.ts packages/web/test/lib/approval-api.test.ts packages/web/test/hooks/use-approval-center.test.ts
git commit -m "feat: add approval center client state"
```

### Task 8: Add approval center routes and nav entry

**Files:**

- Create: `packages/web/src/pages/ApprovalPage.tsx`
- Create: `packages/web/src/components/approval/ApprovalTabs.tsx`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/components/layout/NavBar.tsx`
- Modify: `packages/web/public/locales/zh/translation.json`
- Modify: `packages/web/public/locales/en/translation.json`

- [ ] **Step 1: Write failing route/nav test coverage**

If route coverage lives in component tests, add assertions that the nav includes approval center and that `/approval/anchors` renders by default.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/web/test/components/ProcessPanel.test.tsx`
Expected: FAIL or extend with a new component test file that fails because approval center is missing.

- [ ] **Step 3: Implement routes and copy**

Add router entries:

```tsx
<Route path="/approval/:kind" element={<ApprovalPage />} />
<Route path="*" element={<Navigate to="/approval/anchors" replace />} />
```

Update `NavBar` so the center tab links to the last visited approval path (fallback `/approval/anchors`). Add translation keys for approval center labels and gesture copy.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/web/test/components/ProcessPanel.test.tsx`
Expected: PASS after route/nav assertions are updated or replaced.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/pages/ApprovalPage.tsx packages/web/src/components/approval/ApprovalTabs.tsx packages/web/src/App.tsx packages/web/src/components/layout/NavBar.tsx packages/web/public/locales/zh/translation.json packages/web/public/locales/en/translation.json
git commit -m "feat: add approval center navigation"
```

### Task 9: Implement swipe card, detail sheet, and tab-specific semantics

**Files:**

- Create: `packages/web/src/components/approval/CandidateCard.tsx`
- Create: `packages/web/src/components/approval/CandidateDetailSheet.tsx`
- Modify: `packages/web/src/pages/ApprovalPage.tsx`
- Test: `packages/web/test/components/CandidateCard.test.tsx`

- [ ] **Step 1: Write failing interaction tests**

Add tests for:

```tsx
it("shows semantic preview text before releasing swipe");
it("maps anchor tab swipe directions to approve / question-only / reject / undo");
it("maps probe tab swipe directions to approve / skip / reject / undo");
it("opens detail sheet on tap for micro-edit and update-existing flow");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/web/test/components/CandidateCard.test.tsx`
Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement the mobile-first approval UI**

Requirements:

- swipe previews must show text before release
- anchor tab: right=`approve question+answer`, left=`question only`, up=`reject`, down=`undo`
- probe tab: right=`approve probe`, left=`skip`, up=`reject`, down=`undo`
- taps open detail UI for source context, micro-edit, and update-existing selection
- detail-driven updates must submit target `updatedAt` for OCC

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/web/test/components/CandidateCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/approval/CandidateCard.tsx packages/web/src/components/approval/CandidateDetailSheet.tsx packages/web/src/pages/ApprovalPage.tsx packages/web/test/components/CandidateCard.test.tsx
git commit -m "feat: add swipe-based approval center ui"
```

## Chunk 4: Formal Asset Management, Observability, And Verification

### Task 10: Align formal asset management with the new gateway

**Files:**

- Modify: `packages/web/src/pages/AnchorsPage.tsx`
- Modify: `packages/web/src/hooks/use-anchors.ts`
- Test: `packages/web/test/hooks/use-anchors.test.ts`

- [ ] **Step 1: Write failing tests for formal asset actions**

Add coverage for any new deny/micro-edit API shape, verify `answer=null` remains a first-class asset state, and prove web consumers can load a formal asset with `source: "reading"` without type drift.

Also add request-id coverage for the legacy asset-management entrypoints:

- micro-edit must generate and send a stable `requestId`
- deny must generate and send a stable `requestId`
- retries of the same user-intended mutation must reuse the same `requestId`

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/web/test/hooks/use-anchors.test.ts`
Expected: FAIL after changing hook/API expectations.

- [ ] **Step 3: Update asset management UI**

Keep `AnchorsPage` as the formal soul asset library, but make sure edits and soul-deny operations call the gateway-backed APIs instead of assuming legacy direct writes.

Any web-facing formal-asset types used here must share the expanded producer source contract (`interview | manual | reading`) rather than redefining a narrower local union.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/web/test/hooks/use-anchors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/pages/AnchorsPage.tsx packages/web/src/hooks/use-anchors.ts packages/web/test/hooks/use-anchors.test.ts
git commit -m "refactor: align soul asset management with approval gateway"
```

### Task 11: Add observability and final integration verification

**Files:**

- Modify: `packages/server/src/approval/service.ts`
- Create: `packages/server/src/approval/alerts.ts`
- Modify: `packages/server/src/logger.ts`
- Test: `packages/server/test/routes/approval.test.ts`
- Test: `packages/server/test/routes/interview.test.ts`
- Test: `packages/server/test/routes/anchors.test.ts`

- [ ] **Step 1: Write failing verification tests**

Add assertions that successful approvals emit/record enough information to distinguish:

- `approval_applied`
- `approval_committed`
- `candidate_created`
- `candidate_skipped`
- `candidate_deleted`
- `candidate_restored`
- `formal_asset_written(actionType=...)`
- `undo_applied`
- `approval_rolled_back`
- `direct_write_blocked`
- `approval_rejected_already_processed`
- `approval_rejected_stale_target`
- `approval_idempotency_hit`
- `undo_rejected_conflict`
- `approval_tx_failed`

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- packages/server/test/routes/approval.test.ts packages/server/test/routes/interview.test.ts packages/server/test/routes/anchors.test.ts`
Expected: FAIL because those observability points are not wired yet.

- [ ] **Step 3: Implement observability + run focused suites**

Record gateway-level structured logs/counters for the plan’s required signals, and encode alert rules in `packages/server/src/approval/alerts.ts` so they are testable instead of implicit.

Alert transport for the first iteration is explicit: `alerts.ts` produces standardized alert payloads, and the server emits them through structured `logger.error({ alertType, ownerKey, requestId, actionId, candidateId, gateway, actionType, ... })` records. Do not leave alerts as in-memory booleans or dead helper returns.

Minimum event field contract:

- `candidate_created`: `candidateId`, `source`, `ownerKey`
- `candidate_skipped`: `candidateId`, `requestId`, `ownerKey`
- `approval_applied`: `candidateId`, `requestId`, `actionId`, `ownerKey`
- `approval_committed`: `candidateId`, `requestId`, `actionId`, `assetId`, `ownerKey`
- `candidate_deleted`: `candidateId`, `requestId`, `actionId`, `ownerKey`
- `formal_asset_written`: `assetId`, `candidateId?`, `requestId?`, `actionId`, `ownerKey`, `gateway`, `actionType`
- `undo_applied`: `undoneActionId`, `actionId`, `assetId`, `candidateId`, `ownerKey`
- `candidate_restored`: `actionId`, `candidateId`, `ownerKey`
- `approval_rolled_back`: `actionId`, `assetId`, `candidateId`, `ownerKey`
- `direct_write_blocked`: `routeOrModule`, `ownerKey`, `attemptedAction`

`formal_asset_written` matrix:

- all rows must emit `assetId`, `actionId`, `ownerKey`, `gateway="controlled_write_service"`, `actionType`
- `actionType=approval | update_existing`: `candidateId` and `requestId` are required
- `actionType=micro_edit | deny`: `requestId` is required and `candidateId=null`
- `actionType=undo`: `candidateId` is copied from the undone action and `requestId=null`
- do not omit keys; use explicit `null` when the matrix says the field is absent

Correlation rules:

- success path uses `actionId` as the primary uniqueness key and `requestId` as the retry/debug key
- every `approval_committed.actionId` must match exactly one `formal_asset_written.actionId`
- undo path uses `undoneActionId -> prior formal_asset_written.actionId` to prove which formal write was reverted

Make the verification explicit:

- one success-path assertion (`approval_applied` -> `formal_asset_written` -> `candidate_deleted`)
- one conflict-path assertion (`approval_rejected_stale_target` or `approval_rejected_already_processed`)
- one boundary-break assertion (`direct_write_blocked` or forbidden `formal_asset_written(actionType=other)`)
- one skip assertion (`candidate_skipped`)
- one undo/rollback assertion (`undo_applied` -> `candidate_restored` -> `approval_rolled_back`)
- one static check that no route outside the gateway still calls `insert/update/delete(soulAnchors)`
- explicit alert rules for `approval_tx_failed`, `direct_write_blocked`, and any `formal_asset_written` with `actionType=other` or unexpected gateway metadata
- explicit correlation rules so success and undo paths can be matched by `requestId` / `actionId`

- [ ] **Step 4: Run verification suite**

Run:

```bash
npm test -- packages/server/test/routes/approval.test.ts packages/server/test/routes/anchors.test.ts packages/server/test/routes/interview.test.ts packages/web/test/lib/approval-api.test.ts packages/web/test/hooks/use-approval-center.test.ts packages/web/test/components/CandidateCard.test.tsx packages/web/test/hooks/use-anchors.test.ts
npm test -- packages/server/test/approval/service.test.ts
npm run lint
rg "insert\(soulAnchors\)|update\(soulAnchors\)|delete\(soulAnchors\)" packages/server/src
```

Expected: tests PASS, lint PASS, and `rg` only reports the unified approval gateway implementation.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/approval/service.ts packages/server/src/approval/alerts.ts packages/server/src/logger.ts packages/server/test/routes/approval.test.ts packages/server/test/routes/interview.test.ts packages/server/test/routes/anchors.test.ts
git commit -m "feat: instrument approval center rollout"
```
