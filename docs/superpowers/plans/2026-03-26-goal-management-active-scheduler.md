# Goal Management Active Scheduler Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the MVP goal-tree and active scheduling foundation to ReMi, including session-backed task nodes, signed execution-layer integration, and a platform-driven activation loop.

**Architecture:** Extend the per-user SQLite schema with goal-tree state, add a server-side active-scheduler domain in `packages/server/src/`, and expose authenticated APIs for managing goal nodes plus a platform scheduler runner that performs `refresh -> recompute -> path_select -> act`. Execution-layer calls use a signed protocol derived from the user identity public key and a server root seed.

**Tech Stack:** TypeScript, Hono, better-sqlite3, Drizzle schema definitions, Vitest, existing auth middleware, existing per-user SQLite connection model

---

## File Map

### Existing files to modify

- `packages/server/src/db/schema.ts`
  - Add Drizzle tables for goal nodes and any minimal scheduler metadata stored per user.
- `packages/server/src/db/migrate.ts`
  - Create new SQLite tables and indexes for goal nodes.
- `packages/server/src/app.ts`
  - Register new goal routes only; keep app assembly side-effect free.
- `packages/server/src/index.ts`
  - Start the fixed-interval platform runner from process bootstrap when enabled.
- `packages/server/src/types.ts`
  - Reuse or extend shared request context typing if new route context values are needed.

### New server files to create

- `packages/server/src/goals/constants.ts`
  - Goal-node enums, hard limits, and shared constants.
- `packages/server/src/goals/types.ts`
  - Internal types for goal nodes, recomputed state, activation decisions, and execution-layer payloads.
- `packages/server/src/goals/repository.ts`
  - CRUD and query layer for goal nodes in per-user SQLite.
- `packages/server/src/goals/state.ts`
  - Recompute logic from persisted node data + execution-layer refresh.
- `packages/server/src/goals/path-selection.ts`
  - Root-to-leaf greedy path selection.
- `packages/server/src/goals/tree-mutation.ts`
  - Activation-time tree maintenance: create/replace/cancel nodes and enforce max-5 children rule.
- `packages/server/src/goals/service.ts`
  - High-level goal tree operations and shared validation used by routes and scheduler.
- `packages/server/src/goals/execution-auth.ts`
  - HKDF-based `execution_trust_pubkey` derivation and request signing helpers.
- `packages/server/src/goals/execution-client.ts`
  - Signed HTTP client for `health`, `sessions`, `status/batch`, and `messages` calls.
- `packages/server/src/goals/scheduler.ts`
  - One activation cycle implementation: refresh, recompute, select, act.
- `packages/server/src/goals/platform-runner.ts`
  - Fixed-interval fairness loop driven by `.env`.
- `packages/server/src/routes/goals.ts`
  - Owner-facing goal tree APIs.

### New test files to create

- `test/goals-repository.test.ts`
- `test/goals-tree-mutation.test.ts`
- `test/goals-state.test.ts`
- `test/goals-path-selection.test.ts`
- `test/execution-auth.test.ts`
- `test/execution-client.test.ts`
- `test/platform-scheduler.test.ts`
- `test/goals-routes.test.ts`

## Chunk 1: Data Model And Goal Tree API Foundation

### Task 1: Add failing schema test coverage

**Files:**

- Test: `test/goals-repository.test.ts`
- Modify: `packages/server/src/db/schema.ts`
- Modify: `packages/server/src/db/migrate.ts`

- [ ] **Step 1: Write the failing schema test**

Create `test/goals-repository.test.ts` to assert that a fresh per-user database can store and read a `goal_node` row with:

- `id`
- `parent_id`
- `type`
- `title`
- `objective`
- `status`
- `dependency_ids`
- `execution_base_url`
- `external_session_id`

The test should also assert that `dependency_ids` round-trips as JSON text and that root nodes allow `parent_id = null`.

- [ ] **Step 2: Run the new test and verify it fails**

Run: `npm test -- goals-repository.test.ts`
Expected: FAIL because the table/schema does not exist yet.

- [ ] **Step 3: Add the minimal table definition**

Update `packages/server/src/db/schema.ts` and `packages/server/src/db/migrate.ts` to add a `goal_nodes` table with snake_case columns matching the spec, plus an index on `parent_id`.

- [ ] **Step 4: Run the new test and verify it passes**

Run: `npm test -- goals-repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/goals-repository.test.ts packages/server/src/db/schema.ts packages/server/src/db/migrate.ts
git commit -m "feat: add goal node persistence"
```

### Task 2: Build repository primitives with TDD

**Files:**

- Create: `packages/server/src/goals/constants.ts`
- Create: `packages/server/src/goals/types.ts`
- Create: `packages/server/src/goals/repository.ts`
- Test: `test/goals-repository.test.ts`

- [ ] **Step 1: Extend the failing test for repository operations**

Add tests for:

- create root goal node
- create child goal node
- create session node
- enforce max 5 children per parent at repository/service boundary input
- list children by parent
- update node status

- [ ] **Step 2: Run the repository test and verify it fails**

Run: `npm test -- goals-repository.test.ts`
Expected: FAIL because repository helpers do not exist.

- [ ] **Step 3: Implement minimal repository/constants/types**

Implement:

- goal status/type constants
- repository helpers for insert/select/update
- JSON serialization for `dependency_ids`

Keep child-limit enforcement in a thin helper rather than scattering magic number `5`.

- [ ] **Step 4: Run the repository test and verify it passes**

Run: `npm test -- goals-repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/goals/constants.ts packages/server/src/goals/types.ts packages/server/src/goals/repository.ts test/goals-repository.test.ts
git commit -m "feat: add goal node repository primitives"
```

### Task 3: Add owner goal-tree routes with TDD

**Files:**

- Create: `packages/server/src/routes/goals.ts`
- Modify: `packages/server/src/app.ts`
- Test: `test/goals-routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Create `test/goals-routes.test.ts` covering owner-only APIs:

- create root node
- create child node under parent
- create session node with node-level `execution_base_url` and `external_session_id`
- reject session node creation without `execution_base_url`
- reject session node creation without `external_session_id`
- reject goal node creation when session-only fields are present
- list tree nodes
- update node status to `cancelled` / `done`
- reject sixth child under same parent
- reject self-dependency and dependency cycles
- reject dependencies pointing outside the same tree
- reject visitor access

- [ ] **Step 2: Run the route test and verify it fails**

Run: `npm test -- goals-routes.test.ts`
Expected: FAIL because the route is missing.

- [ ] **Step 3: Implement minimal routes**

Add a small Hono route module under `/api/:pubKey/goals` that uses existing auth/role middleware assumptions and the repository/service layer.

- [ ] **Step 4: Run the route test and verify it passes**

Run: `npm test -- goals-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/goals.ts packages/server/src/app.ts test/goals-routes.test.ts
git commit -m "feat: add goal tree management routes"
```

### Task 4: Add failing tests for activation-time tree maintenance

**Files:**

- Create: `packages/server/src/goals/tree-mutation.ts`
- Modify: `packages/server/src/goals/service.ts`
- Test: `test/goals-tree-mutation.test.ts`

- [ ] **Step 1: Write failing tree-mutation tests**

Cover:

- create `goal` node during activation
- create `session` node during activation
- reject activation-time `goal` creation when session-only fields are present
- reject activation-time `session` creation without `execution_base_url`
- reject activation-time `session` creation without `external_session_id`
- reject activation-time self-dependency
- reject activation-time dependency cycles
- reject activation-time dependencies pointing outside the same tree
- cancel or replace an existing child before adding a sixth child
- reject adding a sixth child without a prior replacement/cancel
- recompute child visibility correctly after dependency changes

- [ ] **Step 2: Run the tree-mutation test and verify it fails**

Run: `npm test -- goals-tree-mutation.test.ts`
Expected: FAIL because mutation helpers do not exist.

- [ ] **Step 3: Implement minimal mutation helpers**

Implement focused helpers for activation-time mutations and keep all child-limit, dependency, and session-only field validation in the shared service layer so scheduler paths cannot bypass route checks.

- [ ] **Step 4: Run the tree-mutation test and verify it passes**

Run: `npm test -- goals-tree-mutation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/goals/tree-mutation.ts packages/server/src/goals/service.ts test/goals-tree-mutation.test.ts
git commit -m "feat: add goal tree mutation helpers"
```

## Chunk 2: Execution-Layer Auth, Client, And State Refresh

### Task 5: Add failing tests for execution auth derivation

**Files:**

- Create: `packages/server/src/goals/execution-auth.ts`
- Test: `test/execution-auth.test.ts`

- [ ] **Step 1: Write failing auth tests**

Create tests that lock down:

- HKDF-SHA256 derivation from `root_seed` + `user_identity_pubkey`
- stable `execution_trust_pubkey`
- canonical string generation
- body hash formatting

Use fixed test vectors so different implementations can be compared later.

- [ ] **Step 2: Run the auth test and verify it fails**

Run: `npm test -- execution-auth.test.ts`
Expected: FAIL because helper module does not exist.

- [ ] **Step 3: Implement minimal auth/signing helpers**

Implement deterministic derivation, canonical request formatting, and signing utilities exactly as specified in the design doc.

- [ ] **Step 4: Run the auth test and verify it passes**

Run: `npm test -- execution-auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/goals/execution-auth.ts test/execution-auth.test.ts
git commit -m "feat: add execution layer signing helpers"
```

### Task 6: Add failing tests for execution client protocol

**Files:**

- Create: `packages/server/src/goals/execution-client.ts`
- Test: `test/execution-client.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Cover:

- signed `GET /health`
- signed `POST /sessions/status/batch`
- signed `GET /sessions/:id/messages`
- signed `POST /sessions`
- signed `POST /sessions/:id/messages`
- rejecting non-`idle` append responses such as `409`
- rejecting unknown execution statuses from the execution layer

Mock `fetch` and assert exact headers, paths, and body hash behavior.

- [ ] **Step 2: Run the protocol test and verify it fails**

Run: `npm test -- execution-client.test.ts`
Expected: FAIL because client module does not exist.

- [ ] **Step 3: Implement minimal signed client**

Implement a focused client that:

- signs every request
- treats `/health` as signed too
- exposes typed methods for all MVP endpoints
- normalizes response payloads for scheduler use

- [ ] **Step 4: Run the protocol test and verify it passes**

Run: `npm test -- execution-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/goals/execution-client.ts test/execution-client.test.ts
git commit -m "feat: add execution layer client"
```

### Task 7: Add failing tests for state recompute

**Files:**

- Create: `packages/server/src/goals/state.ts`
- Test: `test/goals-state.test.ts`

- [ ] **Step 1: Write failing state tests**

Cover the recompute priority rules from the spec:

- `cancelled` wins
- explicit local `done` wins over execution idle
- unmet dependencies produce `blocked`
- execution `running` produces `running`
- execution `idle` + satisfied dependencies produces `todo`
- execution `cancelled` maps to local `cancelled`
- unknown execution status is rejected

Include at least one goal parent case and one session node case.

- [ ] **Step 2: Run the state test and verify it fails**

Run: `npm test -- goals-state.test.ts`
Expected: FAIL because recompute module does not exist.

- [ ] **Step 3: Implement minimal recompute logic**

Implement pure functions so this logic stays testable and reusable from both routes and scheduler.

- [ ] **Step 4: Run the state test and verify it passes**

Run: `npm test -- goals-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/goals/state.ts test/goals-state.test.ts
git commit -m "feat: add goal state recompute logic"
```

## Chunk 3: Path Selection And Activation Engine

### Task 8: Add failing tests for greedy path selection

**Files:**

- Create: `packages/server/src/goals/path-selection.ts`
- Test: `test/goals-path-selection.test.ts`

- [ ] **Step 1: Write failing path-selection tests**

Cover:

- root-to-leaf traversal over a mixed `goal`/`session` tree
- skipping `done`, `cancelled`, and `blocked`
- skipping subtrees with no appendable `session`
- respecting dependency gating before value choice

For MVP, mock the value chooser as a deterministic injected function so tests do not depend on real LLM calls.

- [ ] **Step 2: Run the path-selection test and verify it fails**

Run: `npm test -- goals-path-selection.test.ts`
Expected: FAIL because selector module does not exist.

- [ ] **Step 3: Implement minimal selector**

Keep the module pure. It should accept recomputed nodes and a chooser callback, then return the selected path and terminal node.

- [ ] **Step 4: Run the path-selection test and verify it passes**

Run: `npm test -- goals-path-selection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/goals/path-selection.ts test/goals-path-selection.test.ts
git commit -m "feat: add greedy goal path selection"
```

### Task 9: Add failing tests for one activation cycle

**Files:**

- Create: `packages/server/src/goals/service.ts`
- Create: `packages/server/src/goals/scheduler.ts`
- Test: `test/platform-scheduler.test.ts`

- [ ] **Step 1: Write failing activation tests**

Cover one-cycle behavior:

- refresh execution states via batch call
- recompute local node states
- select one path
- allow activation-time tree maintenance before the terminal action
- reject scheduler-triggered mutation when it violates self-dependency / cycle / cross-tree rules
- persist a newly created `session` node with complete `execution_base_url` and `external_session_id`
- either create a new session or append to one idle session
- never perform more than one external write in the cycle
- reject append when execution state is `running`

- [ ] **Step 2: Run the scheduler test and verify it fails**

Run: `npm test -- platform-scheduler.test.ts`
Expected: FAIL because activation engine does not exist.

- [ ] **Step 3: Implement minimal activation engine**

Implement:

- state refresh integration
- path selection integration
- single external action guard
- service helpers for local node updates after create/append

Defer real LLM value ranking by injecting a chooser callback or stub so the engine is testable first.

- [ ] **Step 4: Run the scheduler test and verify it passes**

Run: `npm test -- platform-scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/goals/service.ts packages/server/src/goals/scheduler.ts test/platform-scheduler.test.ts
git commit -m "feat: add active scheduler cycle"
```

## Chunk 4: Platform Runner, Config, And Manual Verification

### Task 10: Add failing tests for fixed-interval fairness runner

**Files:**

- Create: `packages/server/src/goals/platform-runner.ts`
- Modify: `packages/server/src/index.ts`
- Test: `test/platform-scheduler.test.ts`

- [ ] **Step 1: Extend failing scheduler tests**

Add tests for:

- fixed interval config parsing
- round-robin user activation order
- disabled runner no-op behavior
- no second action inside the same tick for one user activation

- [ ] **Step 2: Run the scheduler test and verify it fails**

Run: `npm test -- platform-scheduler.test.ts`
Expected: FAIL because the runner is not implemented.

- [ ] **Step 3: Implement the minimal platform runner**

Implement:

- `.env`-driven enable flag
- interval loop
- fairness queue over eligible users
- dependency injection so tests can run without real timers or network calls

- [ ] **Step 4: Run the scheduler test and verify it passes**

Run: `npm test -- platform-scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/goals/platform-runner.ts packages/server/src/index.ts test/platform-scheduler.test.ts
git commit -m "feat: add platform fairness runner"
```

### Task 11: Verify end-to-end server behavior

**Files:**

- Modify as needed from previous tasks
- Test: `test/goals-routes.test.ts`
- Test: `test/platform-scheduler.test.ts`

- [ ] **Step 1: Run focused goal/scheduler tests**

Run: `npm test -- goals-repository.test.ts goals-tree-mutation.test.ts goals-state.test.ts goals-path-selection.test.ts execution-auth.test.ts execution-client.test.ts platform-scheduler.test.ts goals-routes.test.ts`
Expected: PASS.

- [ ] **Step 2: Run the full server test suite**

Run: `npm test`
Expected: PASS with no regressions.

- [ ] **Step 3: Do a manual API spot check**

Manually verify in dev:

- create goal node
- create session node with `execution_base_url`
- scheduler refreshes signed `/health` and `/sessions/status/batch`
- idle session accepts append
- running session returns `409` on append

- [ ] **Step 4: Commit final integration changes**

```bash
git add packages/server/src docs/superpowers/specs/2026-03-26-goal-management-active-scheduler-design.md docs/superpowers/plans/2026-03-26-goal-management-active-scheduler.md test
git commit -m "feat: add goal management active scheduler foundation"
```
