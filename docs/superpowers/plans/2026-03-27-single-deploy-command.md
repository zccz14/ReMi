# Single Deploy Command Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-style `npm run deploy` command that builds the Vite frontend, starts the Hono server without watch mode, and serves the built SPA from the backend while leaving `npm run dev` unchanged.

**Architecture:** Keep the existing dev path based on `dev.sh`, `tsx watch`, and Vite proxy mode. Add a separate production shell entrypoint plus a new backend `WEB_MODE=static` path that reads `WEB_DIST_DIR`, serves real files from `packages/web/dist`, and only falls back to `index.html` for HTML navigation requests.

**Tech Stack:** Bash, npm workspaces, Vite, React Router `BrowserRouter`, Hono, Vitest, TypeScript

**Status:** Approved for implementation

---

## File Map

- Modify: `package.json` — add `deploy` and `build:web` scripts, and make sure the runtime can invoke `tsx` explicitly from the workspace.
- Create: `deploy.sh` — production startup entrypoint with `set -euo pipefail`, repo-root resolution, frontend build, default `WEB_DIST_DIR` calculation that still respects caller overrides, and `exec` server startup.
- Modify: `packages/server/src/web/proxy.ts` — extend `WebConfig` to include `static` mode and keep shared web-mode types in one place.
- Create: `packages/server/src/web/static.ts` — resolve `WEB_DIST_DIR`, normalize request paths, block path traversal, serve real files, detect HTML navigations, and provide SPA fallback helpers.
- Modify: `packages/server/src/app.ts` — mount `static` mode after API routes as the final fallback.
- Modify: `packages/server/src/index.ts` — read `WEB_DIST_DIR`, accept `WEB_MODE=static`, validate startup config, and log the final web settings.
- Modify: `packages/server/test/app.proxy.test.ts` — rename/scope the suite if needed so proxy tests remain clear after adding another mode.
- Create: `packages/server/test/app.static.test.ts` — cover root HTML serving, SPA fallback, `/api/health` precedence, missing asset 404, invalid dist path failure, and path normalization safety.
- Modify: `packages/web/vite.config.ts` — confirm root-path deployment assumptions remain true and avoid an accidental non-root `base`.

## Chunk 1: Script Entry Points

### Task 1: Add root npm scripts for build and deploy

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Write the failing script expectation in the plan notes**

Expectation:

```text
Running `npm run deploy` at repo root should currently fail because no such script exists.
```

- [ ] **Step 2: Verify the current failure**

Run: `npm run deploy`
Expected: npm exits non-zero with “Missing script: deploy”.

- [ ] **Step 3: Add the minimal root scripts**

Update `package.json` scripts to include:

```json
{
  "build:web": "npm run build --prefix packages/web",
  "deploy": "bash deploy.sh"
}
```

If `tsx` is not already a declared root-available dependency, add it in the workspace dependency set used by root scripts.

- [ ] **Step 4: Re-run script listing sanity check**

Run: `npm run`
Expected: output includes `build:web` and `deploy`.

### Task 2: Create the production startup shell script

**Files:**

- Create: `deploy.sh`

- [ ] **Step 1: Write the failing startup expectation**

Expectation:

```text
The repo currently has no production startup script that builds the frontend and execs the backend in static mode.
```

- [ ] **Step 2: Create the script with minimal required contract**

Implement `deploy.sh` with this structure:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

mkdir -p data
npm run build:web

DEFAULT_WEB_DIST_DIR="$(cd packages/web/dist && pwd)"
if [ "${WEB_DIST_DIR+x}" != "x" ]; then
  :
else
  WEB_DIST_DIR="$DEFAULT_WEB_DIST_DIR"
fi
export WEB_DIST_DIR
export WEB_MODE=static

exec npx tsx packages/server/src/index.ts
```

Keep `PORT`, `HOST`, `NODE_ENV`, and other incoming env vars untouched.
The script must compute a default absolute dist path but preserve a caller-provided `WEB_DIST_DIR` override exactly, including an explicit empty-string override for failure-path testing.

- [ ] **Step 3: Make the script executable**

Run: `chmod +x deploy.sh`
Expected: shell command succeeds.

- [ ] **Step 4: Smoke-check the script structure**

Run: `bash -n deploy.sh`
Expected: no syntax errors.

## Chunk 2: Static Web Serving in the Backend

### Task 3: Extend web-mode typing for static serving

**Files:**

- Modify: `packages/server/src/web/proxy.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Write the failing type expectation**

Expectation:

```ts
const mode: "disabled" | "proxy" | "static" = "static";
```

This should not be representable before the change because `WebConfig` only allows `disabled | proxy`.

- [ ] **Step 2: Update the shared web config type**

Add `static` to the `WebConfig.mode` union, and add an optional `distDir?: string` field for resolved static assets.

- [ ] **Step 3: Update server startup config wiring**

In `packages/server/src/index.ts`, read:

```ts
const WEB_MODE = (process.env.WEB_MODE ?? "disabled") as "disabled" | "proxy" | "static";
const WEB_DIST_DIR = process.env.WEB_DIST_DIR;
```

Pass `distDir: WEB_DIST_DIR` into `createApp({ web: ... })` and include it in startup logs when present.

- [ ] **Step 4: Verify TypeScript still parses the touched files**

Run: `npx tsc -p packages/server/tsconfig.json --noEmit`
Expected: no new type errors from the edited web config paths.

### Task 4: Add a focused static file service module

**Files:**

- Create: `packages/server/src/web/static.ts`
- Test: `packages/server/test/app.static.test.ts`

- [ ] **Step 1: Write failing tests for static behavior**

Add tests covering at least:

```ts
it("serves index.html for / in static mode", async () => {
  /* ... */
});
it("serves index.html for /messages HTML navigations", async () => {
  /* ... */
});
it("returns 404 for missing .js assets", async () => {
  /* ... */
});
it("rejects traversal-like paths outside the dist dir", async () => {
  /* ... */
});
```

Use a temp dist directory with real files such as `index.html` and `assets/app.js`.
Also add explicit fail-fast tests for an invalid `WEB_DIST_DIR` and a missing `index.html`.

- [ ] **Step 2: Run the new static test file to confirm failure**

Run: `npx vitest run packages/server/test/app.static.test.ts`
Expected: FAIL because the static module and mode are not implemented yet.

- [ ] **Step 3: Implement the static serving helpers**

In `packages/server/src/web/static.ts`, add helpers for:

```ts
resolveStaticDir(distDir: string): string
isHtmlNavigationRequest(request: Request): boolean
resolveStaticAssetPath(distDir: string, pathname: string): string | null
serveStaticRequest(request: Request, distDir: string): Promise<Response | null>
```

Implementation rules:

- Require `distDir` and `index.html` to exist during startup validation.
- Normalize and decode pathnames before mapping to disk.
- Reject paths that escape the dist dir.
- Serve real files when present.
- Only fall back to `index.html` for `GET`/`HEAD` requests that are HTML navigations and do not carry a file extension.
- Return `404` for missing extension-based asset requests.

- [ ] **Step 4: Re-run the static test file**

Run: `npx vitest run packages/server/test/app.static.test.ts`
Expected: PASS.

### Task 5: Mount static mode in the Hono app

**Files:**

- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/test/app.proxy.test.ts`
- Test: `packages/server/test/app.static.test.ts`

- [ ] **Step 1: Add one integration-style failing assertion for route precedence**

Add/keep tests proving `/api/health` stays owned by Hono even when `web.mode === "static"`, and `/ai/*` requests are not swallowed by SPA fallback.

- [ ] **Step 2: Run the relevant test subset to confirm current failure**

Run: `npx vitest run packages/server/test/app.static.test.ts packages/server/test/app.proxy.test.ts`
Expected: static tests fail or route precedence is not yet implemented.

- [ ] **Step 3: Implement the app integration**

In `packages/server/src/app.ts`:

- keep API and AI routes unchanged
- keep proxy mode behavior unchanged
- add a final `if (config.web?.mode === "static")` branch after API route registration
- call the new static helper only for non-`/api` and non-`/ai` fallthrough requests

Pseudo-shape:

```ts
if (config.web?.mode === "static") {
  const distDir = resolveStaticDir(config.web.distDir ?? "");
  app.all("*", (c) => serveStaticRequest(c.req.raw, distDir));
}
```

Make sure startup validation happens before requests are served.

- [ ] **Step 4: Re-run the focused server tests**

Run: `npx vitest run packages/server/test/app.static.test.ts packages/server/test/app.proxy.test.ts`
Expected: PASS.

## Chunk 3: End-to-End Command Verification

### Task 6: Verify the deploy command end to end

**Files:**

- Modify: `deploy.sh` (if smoke test reveals issues)
- Modify: `package.json` (if script wiring needs correction)
- Modify: `packages/web/vite.config.ts` (if root-path deployment assumptions are not explicit)

- [ ] **Step 1: Run frontend build directly**

Run: `npm run build:web`
Expected: Vite production build succeeds and writes `packages/web/dist`.

- [ ] **Step 2: Make root-path deployment behavior explicit in Vite config if needed**

Check `packages/web/vite.config.ts`.
Expected: the config makes root deployment explicit, preferably with `base: "/"`, so the deploy plan does not rely on an implicit default.

- [ ] **Step 3: Verify built asset paths match root deployment**

Check `packages/web/dist/index.html`.
Expected: generated asset URLs match root-path deployment expectations.

- [ ] **Step 4: Start the production command**

Run: `npm run deploy`
Expected: command builds the frontend, starts the backend in the foreground, and logs static mode startup.

- [ ] **Step 5: Smoke-test the HTTP behavior from another shell**

Run:

```bash
curl -i http://127.0.0.1:3000/
curl -i http://127.0.0.1:3000/messages
curl -i http://127.0.0.1:3000/api/health
curl -i http://127.0.0.1:3000/assets/does-not-exist.js
```

Expected:

- `/` returns HTML
- `/messages` returns HTML
- `/api/health` returns `200` with `{"status":"ok"}`
- missing asset returns `404`

- [ ] **Step 6: Verify fail-fast behavior for bad static configuration**

Run: `WEB_DIST_DIR="/tmp/remi-missing-dist" npm run deploy`
Expected: command exits non-zero during startup validation before serving requests.

- [ ] **Step 7: Verify deploy exits non-zero when frontend build fails**

Use a temporary local breakage in the frontend build path, run `npm run deploy`, confirm the command exits non-zero, then revert the temporary breakage before continuing.

- [ ] **Step 8: Re-run the existing dev command smoke check**

Run: `npm run dev`
Expected: dev server still uses Vite on `5173` plus watched backend behavior, with no regression to proxy mode.

- [ ] **Step 9: Run the targeted automated tests before handoff**

Run: `npx vitest run packages/server/test/app.static.test.ts packages/server/test/app.proxy.test.ts && npx tsc -p packages/server/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add package.json deploy.sh packages/server/src/index.ts packages/server/src/app.ts packages/server/src/web/proxy.ts packages/server/src/web/static.ts packages/server/test/app.proxy.test.ts packages/server/test/app.static.test.ts
git commit -m "feat: add single-command production deploy mode"
```

If `packages/web/vite.config.ts` changes, include it in the same commit.
