# Memory Removal Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove built-in `memories` / `memories_vec` from runtime code and add a one-shot explicit migration command for deleting those legacy tables from a specified SQLite file.

**Architecture:** Keep runtime DB initialization non-destructive by stopping creation of memory tables in `initializeDatabase()`. Move destructive cleanup into a dedicated CLI-style script that validates a target SQLite path, opens that database only, and drops `memories` / `memories_vec` inside one transaction. Narrow embedding/table types and update tests to reflect the new contract.

**Tech Stack:** TypeScript, better-sqlite3, sqlite-vec, Vitest, tsx

---

## Chunk 1: Runtime Contract Cleanup

### Task 1: Remove runtime memory table definitions

**Files:**

- Modify: `packages/server/src/db/schema.ts`
- Modify: `packages/server/src/db/migrate.ts`
- Test: `packages/server/test/db/migrate.test.ts`

- [ ] **Step 1: Write/update the failing migration test expectations**

Update `packages/server/test/db/migrate.test.ts` so database initialization no longer expects `memories` or `memories_vec` to exist.

- [ ] **Step 2: Run the focused migration test to verify failure**

Run: `npm test -- --run packages/server/test/db/migrate.test.ts`
Expected: FAIL because runtime still creates memory tables.

- [ ] **Step 3: Remove the runtime schema/table creation**

Change:

- delete `memories` from `packages/server/src/db/schema.ts`
- remove `CREATE TABLE IF NOT EXISTS memories` from `packages/server/src/db/migrate.ts`
- remove the `rebuildTableWithoutSourceConstraint(... memories ...)` branch
- remove `CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec`

- [ ] **Step 4: Re-run the focused migration test**

Run: `npm test -- --run packages/server/test/db/migrate.test.ts`
Expected: PASS for the updated expectations.

## Chunk 2: Embedding API Narrowing

### Task 2: Restrict vector table usage to soul anchors

**Files:**

- Modify: `packages/server/src/embedding/index.ts`
- Test: `packages/server/test/embedding/index.test.ts`

- [ ] **Step 1: Write/update the failing embedding test expectations**

Remove the `memories_vec` test case and keep coverage only for `soul_anchors_vec` behavior.

- [ ] **Step 2: Run the focused embedding test to verify failure**

Run: `npm test -- --run packages/server/test/embedding/index.test.ts`
Expected: FAIL until the type union is narrowed.

- [ ] **Step 3: Narrow the embedding table type**

Change `type VecTable = "soul_anchors_vec" | "memories_vec"` to `type VecTable = "soul_anchors_vec"` in `packages/server/src/embedding/index.ts`.

- [ ] **Step 4: Re-run the focused embedding test**

Run: `npm test -- --run packages/server/test/embedding/index.test.ts`
Expected: PASS.

## Chunk 3: Explicit Legacy Migration Command

### Task 3: Add one-shot command for dropping legacy memory tables

**Files:**

- Create: `packages/server/src/db/remove-memory-tables.ts`
- Test: `packages/server/test/db/remove-memory-tables.test.ts`

- [ ] **Step 1: Write failing tests for the migration command**

Cover at least:

- missing path fails and creates no file
- nonexistent absolute path fails and creates no file
- relative path fails and does not open/create a DB
- directory path fails and does not open/create a DB
- both `memories` and `memories_vec` are dropped
- only one legacy table exists and command still succeeds
- repeated execution remains successful
- command only affects the explicitly passed database file

- [ ] **Step 2: Run the focused migration-command test to verify failure**

Run: `npm test -- --run packages/server/test/db/remove-memory-tables.test.ts`
Expected: FAIL because the command does not exist yet.

- [ ] **Step 3: Implement the explicit migration command**

Implement `tsx packages/server/src/db/remove-memory-tables.ts --db /absolute/path/to/user.sqlite` with:

- absolute-path validation
- existing-file validation
- regular-file validation
- sqlite-vec load
- single transaction dropping `memories_vec` then `memories`
- no non-empty-table detection and no compatibility-preservation logic
- non-zero exit on failure

- [ ] **Step 4: Re-run the focused migration-command test**

Run: `npm test -- --run packages/server/test/db/remove-memory-tables.test.ts`
Expected: PASS.

- [ ] **Step 5: Assert operator-facing command output**

Extend the migration-command test to assert the command output includes:

- the target DB path
- the drop result for `memories` / `memories_vec`
- the backup warning

- [ ] **Step 6: Re-run the focused migration-command test after output assertions**

Run: `npm test -- --run packages/server/test/db/remove-memory-tables.test.ts`
Expected: PASS with the output contract asserted.

## Chunk 4: Full Verification

### Task 4: Verify repo-wide server impact

**Files:**

- Test: `packages/server/test/db/migrate.test.ts`
- Test: `packages/server/test/embedding/index.test.ts`
- Test: `packages/server/test/db/remove-memory-tables.test.ts`

- [ ] **Step 1: Run all touched tests together**

Run: `npm test -- --run packages/server/test/db/migrate.test.ts packages/server/test/embedding/index.test.ts packages/server/test/db/remove-memory-tables.test.ts`
Expected: PASS.

- [ ] **Step 2: Run a compile/build-oriented verification**

Run: `npx tsc --noEmit`
Expected: PASS and no broken imports from removing `memories`.

- [ ] **Step 3: Manual operator smoke check**

Following the runbook, first stop any service using the target DB and back up the SQLite file.

Run: `tsx packages/server/src/db/remove-memory-tables.ts --db /absolute/path/to/test.sqlite`
Expected: clear output describing the target DB path, dropped legacy tables, and a backup warning for the operator.
