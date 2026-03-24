# Backend Watch Reload Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local backend development restart automatically on server code changes while preserving the current `npm run dev` workflow and keeping startup failures visible.

**Architecture:** Keep the change scoped to the development entrypoint. Introduce one small, testable readiness helper that can probe the backend health endpoint and fail loudly when the watched backend never boots, then wire `dev.sh` to launch the backend with `tsx watch` and use that helper instead of bare parent-process liveness.

**Tech Stack:** Bash, Node.js, TypeScript, Vitest, `tsx`, existing Hono `/api/health` route

---

## File Map

- Create: `scripts/wait-for-url.mjs`
  - Small CLI helper that polls a URL until success or timeout and exits non-zero on failure.
- Create: `test/wait-for-url.test.ts`
  - Covers success, timeout, and child-process exit behavior for the readiness helper without depending on shell parsing.
- Modify: `dev.sh`
  - Switches backend startup to `tsx watch`, preserves log files, and replaces the current liveness-only startup check with the readiness helper.
- Modify: `README.md`
  - Documents that backend source edits auto-restart in local development and clarifies that this is restart-based, not HMR.

## Chunk 1: Readiness Helper

### Task 1: Add a testable URL readiness probe

**Files:**

- Create: `scripts/wait-for-url.mjs`
- Create: `test/wait-for-url.test.ts`

- [ ] **Step 1: Write the failing test for successful readiness**

In `test/wait-for-url.test.ts`, add a test that starts a tiny local HTTP server, runs `node scripts/wait-for-url.mjs http://127.0.0.1:<port>/health 1500`, and asserts exit code `0`.

- [ ] **Step 2: Run the success test to verify it fails**

Run: `npm test -- test/wait-for-url.test.ts -t "exits zero when the target URL becomes reachable"`
Expected: FAIL because the helper script does not exist yet.

- [ ] **Step 3: Write the failing test for timeout behavior**

Add a test that points the helper at an unused local port with a short timeout and asserts a non-zero exit code plus timeout text on stderr.

- [ ] **Step 4: Run the timeout test to verify it fails**

Run: `npm test -- test/wait-for-url.test.ts -t "fails non-zero when the target URL never becomes reachable"`
Expected: FAIL because the helper script does not exist yet.

- [ ] **Step 5: Write the failing test for repeated polling before success**

Add a test that delays server startup briefly, runs the helper first, then starts the HTTP server before timeout and asserts the helper still exits `0`.

- [ ] **Step 6: Run the delayed-start test to verify it fails**

Run: `npm test -- test/wait-for-url.test.ts -t "keeps polling until the URL becomes reachable before timeout"`
Expected: FAIL because the helper script does not exist yet.

- [ ] **Step 7: Implement the minimal helper**

Create `scripts/wait-for-url.mjs` with a minimal CLI contract:

```js
#!/usr/bin/env node

const [url, timeoutMsArg] = process.argv.slice(2);
const timeoutMs = Number(timeoutMsArg ?? 5000);
```

Behavior requirements:

- validate that `url` is present and `timeoutMs` is a positive number
- poll with `fetch()` until the URL returns any successful HTTP response
- retry on connection failures and non-2xx responses until timeout
- exit `0` on success
- print a concise failure message to stderr and exit `1` on timeout or invalid args

- [ ] **Step 8: Run the helper test file**

Run: `npm test -- test/wait-for-url.test.ts`
Expected: PASS

- [ ] **Step 9: Commit the readiness helper**

```bash
git add scripts/wait-for-url.mjs test/wait-for-url.test.ts
git commit -m "test(dev): add URL readiness probe helper"
```

## Chunk 2: Wire Watch Mode Into Local Dev

### Task 2: Switch backend startup to `tsx watch` without hiding failures

**Files:**

- Modify: `dev.sh`
- Create: `scripts/wait-for-url.mjs`
- Test: `test/wait-for-url.test.ts`

- [ ] **Step 1: Verify the readiness URL contract before wiring it into `dev.sh`**

Read the current backend startup path and confirm that `http://127.0.0.1:${SERVER_PORT}/api/health` is the correct local readiness URL for both normal dev and `PUBLIC_DEV=1` mode.

- [ ] **Step 2: Update `dev.sh` to run the backend in watch mode**

Replace:

```bash
PORT=$SERVER_PORT WEB_MODE=$SERVER_WEB_MODE VITE_DEV_ORIGIN=$SERVER_VITE_ORIGIN npx tsx packages/server/src/index.ts > server.log 2>&1 &
```

With:

```bash
PORT=$SERVER_PORT WEB_MODE=$SERVER_WEB_MODE VITE_DEV_ORIGIN=$SERVER_VITE_ORIGIN npx tsx watch packages/server/src/index.ts > server.log 2>&1 &
```

Keep the existing log redirection and PID tracking.

- [ ] **Step 3: Replace the backend liveness-only startup check with readiness probing**

In `dev.sh`, after both processes start, keep the frontend `kill -0` check, but replace the backend `kill -0`-only success condition with a call like:

```bash
node scripts/wait-for-url.mjs "http://127.0.0.1:${SERVER_PORT}/api/health" 5000
```

If the helper exits non-zero:

- print `Server failed to start. Check server.log`
- ensure the already-started child processes are cleaned up before exit, either by explicit kill or by relying on the existing `trap cleanup EXIT` path
- exit `1`

This preserves loud failure even when the `tsx watch` parent process remains alive.

- [ ] **Step 4: Run the helper test file again**

Run: `npm test -- test/wait-for-url.test.ts`
Expected: PASS

- [ ] **Step 5: Manually verify local startup and backend restart**

Run: `npm run dev`

Verify:

- backend starts successfully
- frontend starts successfully
- editing `packages/server/src/index.ts` causes backend restart
- frontend process stays up during backend restart

- [ ] **Step 6: Manually verify failure signaling still works**

Temporarily introduce a reversible backend boot failure by changing the backend launch target to a non-existent file such as `packages/server/src/__boot_failure__.ts`, run `npm run dev`, confirm it exits with `Server failed to start. Check server.log`, confirm no frontend/backend child process is left running, then revert the temporary change before continuing.

- [ ] **Step 7: Commit the dev script change**

```bash
git add dev.sh scripts/wait-for-url.mjs test/wait-for-url.test.ts
git commit -m "feat(dev): auto-reload backend during local development"
```

### Task 3: Document the new backend dev behavior and finish verification

**Files:**

- Modify: `README.md`
- Modify: `dev.sh`

- [ ] **Step 1: Apply the docs verification checklist**

Use a verification checklist instead of an automated doc test:

- `README.md` mentions the standard `npm run dev` flow
- the docs make clear the backend auto-restarts on source changes
- the docs make clear this is restart-based behavior, not HMR

- [ ] **Step 2: Update `README.md` minimally**

Add a short note near the development commands explaining that:

- `npm run dev` starts both backend and frontend
- backend TypeScript changes restart the backend automatically
- frontend continues to use Vite's dev behavior

- [ ] **Step 3: Run focused verification for the changed files**

Run: `npm test -- test/wait-for-url.test.ts`
Expected: PASS

- [ ] **Step 4: Run the full repository test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit the documentation update**

```bash
git add README.md dev.sh scripts/wait-for-url.mjs test/wait-for-url.test.ts
git commit -m "docs(dev): clarify backend watch reload workflow"
```
