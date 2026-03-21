# Cloudflared Local Deployment Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ReMi shareable from a local Mac through one temporary `cloudflared` URL backed by one Hono port in proxy mode.

**Architecture:** Keep Hono as the only public local entrypoint. In Phase 1, Hono owns `/api/*` and proxies all non-API browser traffic to the Vite dev server on localhost. The web client uses same-origin relative API paths so the tunnel only needs to expose one URL and one local port.

**Tech Stack:** Hono, `@hono/node-server`, React, Vite, Vitest, Bash, `cloudflared`

**Spec:** `docs/superpowers/specs/2026-03-21-cloudflared-local-deployment-design.md`

---

## File Structure

### New Files

- `packages/server/src/web/proxy.ts` — focused helper that decides whether to proxy a request to Vite and performs the proxy fetch
- `packages/server/test/app.proxy.test.ts` — app-level tests for `/api` ownership and non-API frontend dispatch

### Modified Files

- `packages/server/src/app.ts` — register proxy-mode frontend dispatch after API routes
- `packages/server/src/index.ts` — read proxy-mode env vars and pass web config into `createApp`
- `packages/web/src/hooks/use-auth.tsx` — switch default API base URL to same-origin relative behavior for tunneled access
- `packages/web/vite.config.ts` — bind Vite explicitly to `localhost:5173`
- `dev.sh` — start Hono on `8787`, Vite on `5173`, and surface the public-dev workflow clearly
- `package.json` — add a dedicated local public-dev command if needed instead of overloading existing `dev`
- `.env.example` — document `WEB_MODE` and `VITE_DEV_ORIGIN` for the public-dev path
- `README.md` — document the one-port local workflow and the `cloudflared tunnel --url http://localhost:8787` command

### Notes

- Do not implement static asset serving in this plan.
- Do not expose Vite directly to `cloudflared`.
- Keep proxy logic in a small helper instead of bloating `packages/server/src/app.ts`.

---

## Chunk 1: Server Proxy Boundary

### Task 1: Add app-level tests for proxy-mode routing

**Files:**

- Create: `packages/server/test/app.proxy.test.ts`
- Check: `packages/server/src/app.ts`
- Check: `packages/server/test/routes/health.test.ts`

- [ ] **Step 1: Write the failing test for `/api` ownership**

Create `packages/server/test/app.proxy.test.ts` with a test that builds the full app via `createApp(...)` and asserts `GET /api/health` still returns `{ status: "ok" }` even when proxy mode is enabled.

Use a minimal config shape like:

```ts
const { app } = createApp({
  dataDir: tmpDir,
  embeddingDimensions: 4,
  web: {
    mode: "proxy",
    viteOrigin: "http://127.0.0.1:5173",
  },
});
```

- [ ] **Step 2: Write the failing test for non-API dispatch**

In the same file, add a test that requests `/messages` and expects the app to proxy to a mocked Vite origin and return HTML such as `<html><body>vite ok</body></html>`.

Stub `global.fetch` and assert the proxy target includes the same pathname.

Example assertion shape:

```ts
expect(fetch).toHaveBeenCalledWith(
  "http://127.0.0.1:5173/messages",
  expect.objectContaining({ method: "GET" }),
);
```

- [ ] **Step 3: Write the failing test for passthrough of query strings/assets**

Add one more test that requests something like `/src/main.tsx?t=123` and asserts the proxied URL preserves both pathname and query string.

- [ ] **Step 4: Run the new test file and verify it fails**

Run: `npm test -- packages/server/test/app.proxy.test.ts`

Expected: FAIL because `createApp` does not yet accept web proxy config and does not proxy non-API requests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/test/app.proxy.test.ts
git commit -m "test(server): cover proxy-mode app routing"
```

### Task 2: Implement proxy-mode frontend dispatch in the server

**Files:**

- Create: `packages/server/src/web/proxy.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/test/app.proxy.test.ts`

- [ ] **Step 1: Add a focused proxy helper**

Create `packages/server/src/web/proxy.ts` with two exported helpers:

```ts
export interface WebConfig {
  mode: "disabled" | "proxy";
  viteOrigin?: string;
}

export function shouldProxyToVite(pathname: string): boolean {
  return !pathname.startsWith("/api/") && pathname !== "/api";
}
```

Add a `proxyToVite(request: Request, viteOrigin: string): Promise<Response>` helper that:

- builds the target URL from `pathname + search`
- forwards the original method
- forwards headers except `host`
- forwards body only for non-GET/non-HEAD requests
- returns the fetch response as-is

- [ ] **Step 2: Extend `createApp` config to accept web mode**

In `packages/server/src/app.ts`, extend `AppConfig` with:

```ts
web?: {
  mode?: "disabled" | "proxy";
  viteOrigin?: string;
};
```

After all `/api` routes are registered, add a catch-all handler in proxy mode:

```ts
if (config.web?.mode === "proxy") {
  app.all("*", async (c) => {
    const url = new URL(c.req.url);
    if (!shouldProxyToVite(url.pathname)) {
      return c.notFound();
    }
    return proxyToVite(c.req.raw, config.web?.viteOrigin ?? "http://127.0.0.1:5173");
  });
}
```

Keep this handler after API route registration so `/api/*` remains owned by Hono routes.

- [ ] **Step 3: Wire env vars in `packages/server/src/index.ts`**

Read these env vars near the top of the file:

```ts
const WEB_MODE = (process.env.WEB_MODE ?? "disabled") as "disabled" | "proxy";
const VITE_DEV_ORIGIN = process.env.VITE_DEV_ORIGIN ?? "http://127.0.0.1:5173";
```

Pass them into `createApp({ ..., web: { mode: WEB_MODE, viteOrigin: VITE_DEV_ORIGIN } })`.

Update startup logging to include `webMode` and `viteDevOrigin`.

- [ ] **Step 4: Run the focused tests and make them pass**

Run: `npm test -- packages/server/test/app.proxy.test.ts packages/server/test/routes/health.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`

Expected: PASS with the existing suite still green.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/web/proxy.ts packages/server/src/app.ts packages/server/src/index.ts packages/server/test/app.proxy.test.ts
git commit -m "feat(server): add proxy-mode web entrypoint"
```

---

## Chunk 2: Local Dev Configuration

### Task 3: Land same-origin web client behavior together with the new public-dev entrypoint

**Files:**

- Modify: `packages/web/src/hooks/use-auth.tsx`
- Create: `packages/web/test/hooks/use-auth.test.tsx`
- Modify: `packages/web/vite.config.ts`
- Modify: `dev.sh`
- Modify: `package.json`
- Modify: `.env.example`

- [ ] **Step 1: Write the failing hook test for same-origin API client setup**

Create `packages/web/test/hooks/use-auth.test.tsx` that renders `AuthProvider` with mocked `KeyStore` and mocked `ApiClient`.

Stub `window.location.origin` to `https://demo.trycloudflare.com` and assert that when `import.meta.env.VITE_API_BASE` is unset, the `ApiClient` constructor receives that origin.

In the test harness, explicitly mock the `@remi/client` `KeyStore` constructor, mock `../src/lib/api-client`, and clear or override `import.meta.env.VITE_API_BASE` for the test case instead of relying on ambient dev env state.

Example assertion shape:

```ts
expect(ApiClient).toHaveBeenCalledWith(
  expect.objectContaining({
    baseUrl: "https://demo.trycloudflare.com",
  }),
);
```

- [ ] **Step 2: Run the focused hook test and verify it fails**

Run: `npm test -- packages/web/test/hooks/use-auth.test.tsx`

Expected: FAIL because `use-auth.tsx` still hard-codes `http://localhost:3000`.

- [ ] **Step 3: Update `use-auth` to stop defaulting to `http://localhost:3000`**

Change the API client construction in `packages/web/src/hooks/use-auth.tsx` from:

```ts
baseUrl: import.meta.env.VITE_API_BASE ?? "http://localhost:3000",
```

to a same-origin-safe form such as:

```ts
baseUrl: import.meta.env.VITE_API_BASE ?? window.location.origin,
```

Use the simplest version that keeps tunneled access on same-origin and works once the public-dev entrypoint below is added.

- [ ] **Step 4: Configure Vite to bind explicitly to localhost**

In `packages/web/vite.config.ts`, add a `server` block:

```ts
server: {
  host: "localhost",
  port: 5173,
  strictPort: true,
},
```

This avoids accidentally exposing Vite directly on a broader interface.

- [ ] **Step 5: Add an explicit root `dev:public` command**

Modify root `package.json` to keep the existing root `dev` command unchanged and add:

```json
"dev:public": "bash dev.sh"
```

Do not ask the implementer to choose between command strategies.

- [ ] **Step 6: Update `dev.sh` for the public-dev path**

Modify `dev.sh` so it explicitly starts:

- Hono with `PORT=8787 WEB_MODE=proxy VITE_DEV_ORIGIN=http://127.0.0.1:5173`
- Vite on `localhost:5173`

and prints:

- `App:     http://localhost:8787`
- `Vite:    http://localhost:5173`

Keep writing logs to `server.log` and `web.log`.

- [ ] **Step 7: Document the env knobs in `.env.example`**

Add commented examples so the public-dev path is discoverable:

```dotenv
# Public local sharing (Phase 1 proxy mode)
# WEB_MODE=proxy
# VITE_DEV_ORIGIN=http://127.0.0.1:5173
```

- [ ] **Step 8: Run the focused tests and startup flow**

Run:

```bash
npm test -- packages/web/test/hooks/use-auth.test.tsx packages/web/test/hooks/use-chat.test.ts
npm run dev:public
```

Expected:

- hook tests PASS
- Hono listens on `8787`
- Vite listens on `5173`
- opening `http://localhost:8787` loads the app shell

This is a long-running manual verification step; stop the processes after confirming the ports and page load behavior.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/hooks/use-auth.tsx packages/web/test/hooks/use-auth.test.tsx packages/web/vite.config.ts dev.sh package.json .env.example
git commit -m "feat(dev): add same-origin public dev workflow"
```

---

## Chunk 3: Docs and Manual Verification

### Task 4: Document the temporary Cloudflare workflow

**Files:**

- Modify: `README.md`
- Check: `docs/superpowers/specs/2026-03-21-cloudflared-local-deployment-design.md`

- [ ] **Step 1: Add a short local sharing section to the README**

Document:

- app startup command
- expected local URLs (`http://localhost:8787`, `http://localhost:5173`)
- explicit note that only `8787` should be tunneled
- explicit note that Vite stays on localhost only
- the command:

```bash
cloudflared tunnel --url http://localhost:8787
```

- the requirement that the Mac stay awake and online
- the acceptable HMR fallback: remote visitors may need manual refresh

- [ ] **Step 2: Add a manual verification checklist**

In the same README section, include this ordered checklist:

1. run the public-dev command
2. open `http://localhost:8787`
3. confirm page load and core chat/API flow
4. start `cloudflared tunnel --url http://localhost:8787`
5. open the generated `trycloudflare.com` URL on another device
6. confirm route refresh works
7. confirm no unexpected internal/debug-only routes are reachable

- [ ] **Step 3: Run repo quality checks for touched areas**

Run:

```bash
npm test
npm run format:check
npx eslint packages/server/src/**/*.ts packages/server/test/**/*.ts packages/web/src/hooks/use-auth.tsx packages/web/test/hooks/use-auth.test.tsx packages/web/vite.config.ts
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add cloudflared local sharing workflow"
```

### Task 5: End-to-end local public demo verification

**Files:**

- No new files required

- [ ] **Step 1: Start the app in proxy mode**

Run `npm run dev:public` and confirm the server is on `8787`.

- [ ] **Step 2: Verify local same-origin behavior**

Open `http://localhost:8787` and confirm:

- the app loads
- browser API requests target the same origin
- core pages render

- [ ] **Step 3: Start `cloudflared`**

Run:

```bash
cloudflared tunnel --url http://localhost:8787
```

Copy the generated public URL.

- [ ] **Step 4: Verify the public URL manually**

From a second browser or device, confirm:

- initial page load succeeds
- frontend navigation works
- page refresh on a non-root route still works
- core API-backed flow works
- no direct Vite port is exposed publicly

- [ ] **Step 5: Commit operational notes if the workflow differed**

Only if implementation revealed repo-specific caveats not already documented, append them to `README.md` and create a final docs commit.

```bash
git add README.md
git commit -m "docs: capture cloudflared demo verification notes"
```
