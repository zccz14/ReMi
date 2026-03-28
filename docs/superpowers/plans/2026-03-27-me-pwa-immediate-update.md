# Me 页 PWA 立即更新按钮 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a root-managed PWA update flow that checks for new service worker versions in the background and only shows a `立即更新` button on `Me` when a new version is ready to activate immediately.

**Architecture:** Replace the current implicit PWA update behavior with a single root-owned `useRegisterSW` integration wrapped in a `PwaUpdateProvider`. The provider owns background update checks, maps plugin state to a tiny app-facing API, and keeps `MePage` dumb: it only renders the button when `hasUpdate` is true and calls `applyUpdate()` on click. Verification is split into provider-state tests, config tests, page rendering tests, app wiring tests, and one manual service-worker check so “background checks, button only switches versions” stays locked.

**Tech Stack:** React 19, Vite, `vite-plugin-pwa`, `virtual:pwa-register/react`, Vitest, Testing Library, i18next, Sonner.

---

## Fixed Decisions

- Poll interval constant: `5 * 60 * 1000`
- Apply timeout constant: `10_000`
- Foreground re-check only runs when `document.visibilityState === "visible"`
- PWA registration mode must be `registerType: "prompt"`
- Page code must never call `checkForUpdate()` directly

## File Map

- Modify: `packages/web/vite.config.ts`
  - Align plugin registration semantics with explicit user-triggered refresh.
- Create: `packages/web/test/pwa-config.test.ts`
  - Assert `registerType: "prompt"` in a dedicated config test.
- Create: `packages/web/src/hooks/use-pwa-update.tsx`
  - Root provider and hook exposing `hasUpdate`, `isApplying`, and `applyUpdate()`.
- Create: `packages/web/test/hooks/use-pwa-update.test.tsx`
  - Provider state-machine tests for guard, `needRefresh` mapping, no-op checks, polling, visibility re-check, stale flow, timeout flow, and re-entry protection.
- Modify: `packages/web/src/App.tsx`
  - Mount `PwaUpdateProvider` alongside `PwaInstallProvider`.
- Modify: `packages/web/test/pages/App.test.tsx`
  - Assert the new provider wraps both public and authenticated routes.
- Modify: `packages/web/public/locales/zh/translation.json`
  - Add update CTA and failure copy.
- Modify: `packages/web/public/locales/en/translation.json`
  - Add update CTA and failure copy.
- Create: `packages/web/test/lib/pwa-update-copy.test.ts`
  - Lock the presence of update translation keys.
- Modify: `packages/web/src/pages/MePage.tsx`
  - Render the update button only when `hasUpdate` is true.
- Modify: `packages/web/test/pages/MePage.test.tsx`
  - Assert hidden state, visible state, click wiring, and applying state.

## Chunk 1: Root Update Semantics

### Task 1: Lock the Vite registration mode first

**Files:**

- Create: `packages/web/test/pwa-config.test.ts`
- Modify: `packages/web/vite.config.ts`

- [ ] **Step 1: Write the failing config test**

Create `packages/web/test/pwa-config.test.ts` and assert the exported Vite config uses `registerType: "prompt"`.

- [ ] **Step 2: Run the config test to verify failure**

Run: `npx vitest run packages/web/test/pwa-config.test.ts`
Expected: FAIL because the config still uses `autoUpdate`.

- [ ] **Step 3: Change the PWA plugin config**

Update `packages/web/vite.config.ts` to:

```ts
VitePWA({
  registerType: "prompt",
});
```

Keep manifest, assets, dev options, and workbox rules unchanged.

- [ ] **Step 4: Re-run the config test**

Run: `npx vitest run packages/web/test/pwa-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit the config slice**

```bash
git add packages/web/vite.config.ts packages/web/test/pwa-config.test.ts
git commit -m "chore: align pwa registration with explicit updates"
```

### Task 2: Add the provider guard and `needRefresh` mapping

**Files:**

- Create: `packages/web/test/hooks/use-pwa-update.test.tsx`
- Create: `packages/web/src/hooks/use-pwa-update.tsx`

- [ ] **Step 1: Write the failing guard test**

Add one test that `usePwaUpdate()` throws outside `PwaUpdateProvider`.

- [ ] **Step 2: Run the guard test to verify failure**

Run: `npx vitest run packages/web/test/hooks/use-pwa-update.test.tsx -t "throws when usePwaUpdate is used outside the provider"`
Expected: FAIL because the hook file does not exist yet.

- [ ] **Step 3: Create the smallest hook/provider shell**

Create `packages/web/src/hooks/use-pwa-update.tsx` with:

```tsx
interface PwaUpdateContextValue {
  hasUpdate: boolean;
  isApplying: boolean;
  applyUpdate: () => Promise<void>;
}
```

Include a guarded `usePwaUpdate()` and a temporary provider value.

- [ ] **Step 4: Re-run the guard test**

Run: `npx vitest run packages/web/test/hooks/use-pwa-update.test.tsx -t "throws when usePwaUpdate is used outside the provider"`
Expected: PASS.

- [ ] **Step 5: Add the failing `needRefresh` mapping tests**

Mock `useRegisterSW` and assert:

- `needRefresh=false` => `hasUpdate=false`
- `needRefresh=true` => `hasUpdate=true`

- [ ] **Step 6: Run the mapping tests to verify failure**

Run: `npx vitest run packages/web/test/hooks/use-pwa-update.test.tsx -t "maps needRefresh"`
Expected: FAIL because the provider still returns static values.

- [ ] **Step 7: Implement the `needRefresh` mapping**

Use `useRegisterSW` from `virtual:pwa-register/react` and map the plugin state to `hasUpdate`. Keep `applyUpdate()` as a temporary no-op async function for now.

- [ ] **Step 8: Re-run the mapping tests**

Run: `npx vitest run packages/web/test/hooks/use-pwa-update.test.tsx -t "maps needRefresh"`
Expected: PASS.

- [ ] **Step 9: Commit the guard + mapping slice**

```bash
git add packages/web/src/hooks/use-pwa-update.tsx packages/web/test/hooks/use-pwa-update.test.tsx
git commit -m "feat: add pwa update hook shell"
```

### Task 3: Add background update checks

**Files:**

- Modify: `packages/web/src/hooks/use-pwa-update.tsx`
- Modify: `packages/web/test/hooks/use-pwa-update.test.tsx`

- [ ] **Step 1: Add the failing no-op test**

Assert that automatic checks do not throw and do not toast before a registration is available.

- [ ] **Step 2: Run the no-op test to verify failure**

Run: `npx vitest run packages/web/test/hooks/use-pwa-update.test.tsx -t "no-ops when registration is not ready"`
Expected: FAIL.

- [ ] **Step 3: Implement registration caching and no-op checks**

Use `onRegisteredSW` to cache a single registration ref. Add `checkForUpdate()` that returns immediately when registration is missing.

- [ ] **Step 4: Re-run the no-op test**

Run: `npx vitest run packages/web/test/hooks/use-pwa-update.test.tsx -t "no-ops when registration is not ready"`
Expected: PASS.

- [ ] **Step 5: Add the failing initial-check test**

Assert that once `onRegisteredSW` provides the registration, the provider immediately triggers one `registration.update()` call.

- [ ] **Step 6: Run the initial-check test to verify failure**

Run: `npx vitest run packages/web/test/hooks/use-pwa-update.test.tsx -t "runs an initial background update check"`
Expected: FAIL.

- [ ] **Step 7: Implement the initial check**

When `onRegisteredSW` caches the registration, immediately call `checkForUpdate()` once.

- [ ] **Step 8: Re-run the initial-check test**

Run: `npx vitest run packages/web/test/hooks/use-pwa-update.test.tsx -t "runs an initial background update check"`
Expected: PASS.

- [ ] **Step 9: Add the failing interval-check test**

Assert the provider calls `registration.update()` again after `5 * 60 * 1000` with fake timers.

- [ ] **Step 10: Run the interval-check test to verify failure**

Run: `npx vitest run packages/web/test/hooks/use-pwa-update.test.tsx -t "polls for updates every 5 minutes"`
Expected: FAIL.

- [ ] **Step 11: Implement the poll interval**

Add `const POLL_INTERVAL_MS = 5 * 60 * 1000` and one cleanup-safe interval.

- [ ] **Step 12: Re-run the interval-check test**

Run: `npx vitest run packages/web/test/hooks/use-pwa-update.test.tsx -t "polls for updates every 5 minutes"`
Expected: PASS.

- [ ] **Step 13: Add the failing visibility-check test**

Assert `visibilitychange` triggers `registration.update()` only when `document.visibilityState === "visible"`.

- [ ] **Step 14: Run the visibility-check test to verify failure**

Run: `npx vitest run packages/web/test/hooks/use-pwa-update.test.tsx -t "re-checks on visible foreground transitions"`
Expected: FAIL.

- [ ] **Step 15: Implement the visibility listener**

Add one `visibilitychange` listener and clean it up on unmount.

- [ ] **Step 16: Re-run the visibility-check test**

Run: `npx vitest run packages/web/test/hooks/use-pwa-update.test.tsx -t "re-checks on visible foreground transitions"`
Expected: PASS.

- [ ] **Step 17: Commit the background-check slice**

```bash
git add packages/web/src/hooks/use-pwa-update.tsx packages/web/test/hooks/use-pwa-update.test.tsx
git commit -m "feat: add background pwa update checks"
```

### Task 4: Add apply-update success, stale, and timeout flows

**Files:**

- Modify: `packages/web/src/hooks/use-pwa-update.tsx`
- Modify: `packages/web/test/hooks/use-pwa-update.test.tsx`

- [ ] **Step 1: Add the failing success test**

Assert one click on the test consumer calls `updateServiceWorker()` exactly once and flips `isApplying` true while the promise is pending.

- [ ] **Step 2: Run the success test to verify failure**

Run: `npx vitest run packages/web/test/hooks/use-pwa-update.test.tsx -t "applies an available update once"`
Expected: FAIL.

- [ ] **Step 3: Implement the happy-path apply flow**

Rules:

- bail out if already applying
- read latest `needRefresh` snapshot first
- call `updateServiceWorker()` once
- always reset `isApplying` in `finally`

- [ ] **Step 4: Re-run the success test**

Run: `npx vitest run packages/web/test/hooks/use-pwa-update.test.tsx -t "applies an available update once"`
Expected: PASS.

- [ ] **Step 5: Add the failing re-entry guard test**

Assert that calling `applyUpdate()` again while `isApplying=true` does not trigger a second `updateServiceWorker()` call.

- [ ] **Step 6: Run the re-entry test to verify failure**

Run: `npx vitest run packages/web/test/hooks/use-pwa-update.test.tsx -t "ignores repeated apply attempts while updating"`
Expected: FAIL.

- [ ] **Step 7: Implement the re-entry guard**

Return early when `isApplying` is already true.

- [ ] **Step 8: Re-run the re-entry test**

Run: `npx vitest run packages/web/test/hooks/use-pwa-update.test.tsx -t "ignores repeated apply attempts while updating"`
Expected: PASS.

- [ ] **Step 9: Add the failing stale test**

Assert `needRefresh=false` at click time does not call `updateServiceWorker()` and shows the stale toast.

- [ ] **Step 10: Run the stale test to verify failure**

Run: `npx vitest run packages/web/test/hooks/use-pwa-update.test.tsx -t "refuses to apply a stale update"`
Expected: FAIL.

- [ ] **Step 11: Implement stale handling**

Use the provider-local Sonner toast. Do not expose stale state to `MePage`.

- [ ] **Step 12: Re-run the stale test**

Run: `npx vitest run packages/web/test/hooks/use-pwa-update.test.tsx -t "refuses to apply a stale update"`
Expected: PASS.

- [ ] **Step 13: Add the failing timeout test**

Assert a hung `updateServiceWorker()` promise times out after `10_000`, shows the failure toast, and resets `isApplying`.

- [ ] **Step 14: Run the timeout test to verify failure**

Run: `npx vitest run packages/web/test/hooks/use-pwa-update.test.tsx -t "times out a stuck update apply"`
Expected: FAIL.

- [ ] **Step 15: Implement timeout handling**

Use `Promise.race()` with `const APPLY_TIMEOUT_MS = 10_000`.

- [ ] **Step 16: Re-run the timeout test**

Run: `npx vitest run packages/web/test/hooks/use-pwa-update.test.tsx -t "times out a stuck update apply"`
Expected: PASS.

- [ ] **Step 17: Run the full provider test file**

Run: `npx vitest run packages/web/test/hooks/use-pwa-update.test.tsx`
Expected: PASS.

- [ ] **Step 18: Commit the apply-flow slice**

```bash
git add packages/web/src/hooks/use-pwa-update.tsx packages/web/test/hooks/use-pwa-update.test.tsx
git commit -m "feat: add explicit pwa apply-update flow"
```

## Chunk 2: App Wiring And UI

### Task 5: Wire the provider into the app root

**Files:**

- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/test/pages/App.test.tsx`

- [ ] **Step 1: Write the failing app wiring test**

Mock `PwaUpdateProvider` as:

```tsx
PwaUpdateProvider: ({ children }) => <div data-testid="pwa-update-provider">{children}</div>;
```

Assert both public and authenticated routes render inside it.

- [ ] **Step 2: Run the app wiring test to verify failure**

Run: `npx vitest run packages/web/test/pages/App.test.tsx`
Expected: FAIL because `App.tsx` does not mount `PwaUpdateProvider` yet.

- [ ] **Step 3: Mount the provider in `App.tsx`**

Nest `PwaUpdateProvider` once near `PwaInstallProvider` and keep route structure unchanged.

- [ ] **Step 4: Re-run the app wiring test**

Run: `npx vitest run packages/web/test/pages/App.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit the app wiring**

```bash
git add packages/web/src/App.tsx packages/web/test/pages/App.test.tsx
git commit -m "feat: wire pwa update provider at app root"
```

### Task 6: Add update translation resources

**Files:**

- Create: `packages/web/test/lib/pwa-update-copy.test.ts`
- Modify: `packages/web/public/locales/zh/translation.json`
- Modify: `packages/web/public/locales/en/translation.json`

- [ ] **Step 1: Write the failing copy test**

Assert both locale files contain:

- `me.update.cta`
- `me.update.applying`
- `me.update.stale`
- `me.update.failed`

- [ ] **Step 2: Run the copy test to verify failure**

Run: `npx vitest run packages/web/test/lib/pwa-update-copy.test.ts`
Expected: FAIL because the keys do not exist yet.

- [ ] **Step 3: Add the locale keys**

Recommended shape:

```json
"update": {
  "cta": "立即更新",
  "applying": "更新中...",
  "stale": "更新已失效，请稍后再试",
  "failed": "更新失败，请稍后重试"
}
```

Add matching English strings in the same shape.

- [ ] **Step 4: Re-run the copy test**

Run: `npx vitest run packages/web/test/lib/pwa-update-copy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit the copy slice**

```bash
git add packages/web/public/locales/zh/translation.json packages/web/public/locales/en/translation.json packages/web/test/lib/pwa-update-copy.test.ts
git commit -m "feat: add pwa update copy"
```

### Task 7: Render the update button on Me page

**Files:**

- Modify: `packages/web/src/pages/MePage.tsx`
- Modify: `packages/web/test/pages/MePage.test.tsx`

- [ ] **Step 1: Add the failing hidden-state test**

Mock `usePwaUpdate` and assert `hasUpdate=false` does not render `立即更新`.

- [ ] **Step 2: Run the hidden-state test to verify failure**

Run: `npx vitest run packages/web/test/pages/MePage.test.tsx -t "does not show update CTA when no update is available"`
Expected: FAIL because `MePage` does not use `usePwaUpdate` yet.

- [ ] **Step 3: Add the smallest hidden-state wiring**

Import `usePwaUpdate()` and read its values, but render nothing when `hasUpdate` is false.

- [ ] **Step 4: Re-run the hidden-state test**

Run: `npx vitest run packages/web/test/pages/MePage.test.tsx -t "does not show update CTA when no update is available"`
Expected: PASS.

- [ ] **Step 5: Add the failing visible-state test**

Assert `hasUpdate=true` shows `立即更新`.

- [ ] **Step 6: Run the visible-state test to verify failure**

Run: `npx vitest run packages/web/test/pages/MePage.test.tsx -t "shows update CTA when an update is available"`
Expected: FAIL.

- [ ] **Step 7: Render the visible button**

Place it in the same action area as the install CTA.

- [ ] **Step 8: Re-run the visible-state test**

Run: `npx vitest run packages/web/test/pages/MePage.test.tsx -t "shows update CTA when an update is available"`
Expected: PASS.

- [ ] **Step 9: Add the failing click test**

Assert one click calls `applyUpdate()` once.

- [ ] **Step 10: Run the click test to verify failure**

Run: `npx vitest run packages/web/test/pages/MePage.test.tsx -t "calls applyUpdate when update CTA is clicked"`
Expected: FAIL.

- [ ] **Step 11: Wire the click handler**

Use `onClick={() => void applyUpdate()}` and do not trigger any check action.

- [ ] **Step 12: Re-run the click test**

Run: `npx vitest run packages/web/test/pages/MePage.test.tsx -t "calls applyUpdate when update CTA is clicked"`
Expected: PASS.

- [ ] **Step 13: Add the failing applying-state test**

Assert `isApplying=true` disables the button and swaps text to `me.update.applying`.

- [ ] **Step 14: Run the applying-state test to verify failure**

Run: `npx vitest run packages/web/test/pages/MePage.test.tsx -t "disables update CTA while applying"`
Expected: FAIL.

- [ ] **Step 15: Implement only the disabled state**

Keep the button label unchanged for now, but set `disabled={isApplying}`.

- [ ] **Step 16: Re-run the applying-state test and confirm only the copy assertion still fails**

Run: `npx vitest run packages/web/test/pages/MePage.test.tsx -t "disables update CTA while applying"`
Expected: FAIL only because the text has not switched yet.

- [ ] **Step 17: Implement the applying copy switch**

Render:

```tsx
{
  hasUpdate ? (
    <Button disabled={isApplying} onClick={() => void applyUpdate()}>
      {isApplying ? t("me.update.applying") : t("me.update.cta")}
    </Button>
  ) : null;
}
```

- [ ] **Step 18: Re-run the applying-state test**

Run: `npx vitest run packages/web/test/pages/MePage.test.tsx -t "disables update CTA while applying"`
Expected: PASS.

- [ ] **Step 19: Add and run the repeated-click page test**

Run: `npx vitest run packages/web/test/pages/MePage.test.tsx -t "does not call applyUpdate twice while button is disabled"`
Expected: PASS.

- [ ] **Step 20: Run the full Me page test file**

Run: `npx vitest run packages/web/test/pages/MePage.test.tsx`
Expected: PASS.

- [ ] **Step 21: Commit the page UI**

```bash
git add packages/web/src/pages/MePage.tsx packages/web/test/pages/MePage.test.tsx
git commit -m "feat: show pwa update action on me page"
```

## Chunk 3: Verification

### Task 8: Run the focused automated checks

**Files:**

- Modify as needed: touched files only

- [ ] **Step 1: Run the focused web tests**

Run: `npx vitest run packages/web/test/pwa-config.test.ts packages/web/test/hooks/use-pwa-update.test.tsx packages/web/test/hooks/use-pwa-install.test.tsx packages/web/test/lib/pwa-update-copy.test.ts packages/web/test/pages/MePage.test.tsx packages/web/test/pages/App.test.tsx`
Expected: PASS.

- [ ] **Step 2: Make the smallest fix for any failure**

Allowed targets:

- `packages/web/vite.config.ts`
- `packages/web/src/hooks/use-pwa-update.tsx`
- `packages/web/src/App.tsx`
- `packages/web/src/pages/MePage.tsx`
- touched locale files
- touched test files

- [ ] **Step 3: Re-run the focused web tests**

Run: `npx vitest run packages/web/test/pwa-config.test.ts packages/web/test/hooks/use-pwa-update.test.tsx packages/web/test/hooks/use-pwa-install.test.tsx packages/web/test/lib/pwa-update-copy.test.ts packages/web/test/pages/MePage.test.tsx packages/web/test/pages/App.test.tsx`
Expected: PASS.

- [ ] **Step 4: Run the web build**

Run: `npm run build --workspace @remi/web`
Expected: PASS with no TypeScript or Vite errors.

- [ ] **Step 5: Commit the verified feature**

```bash
git add packages/web/vite.config.ts packages/web/src/hooks/use-pwa-update.tsx packages/web/src/App.tsx packages/web/src/pages/MePage.tsx packages/web/public/locales/zh/translation.json packages/web/public/locales/en/translation.json packages/web/test/pwa-config.test.ts packages/web/test/hooks/use-pwa-update.test.tsx packages/web/test/lib/pwa-update-copy.test.ts packages/web/test/pages/MePage.test.tsx packages/web/test/pages/App.test.tsx
git commit -m "feat: add explicit pwa update action"
```

### Task 9: Run manual service-worker verification

**Files:**

- No source edits expected unless manual verification exposes a real defect

- [ ] **Step 1: Build and serve version A**

Run:

```bash
npm run build --workspace @remi/web
npm run preview --workspace @remi/web -- --host localhost --port 4173
```

Open `http://localhost:4173/me` and keep the preview process running in one terminal.

- [ ] **Step 2: Preserve the version A browser tab and stop the preview process**

Keep the tab open on the old assets, then terminate the preview process from Step 1 so port `4173` is free.

- [ ] **Step 3: Build the real version B from the completed implementation**

Run:

```bash
npm run build --workspace @remi/web
```

Do not introduce any temporary verification-only source edits.

- [ ] **Step 4: Start preview for version B on the same port**

Run again:

```bash
npm run preview --workspace @remi/web -- --host localhost --port 4173
```

Expected: the old tab is still on version A until the update flow completes.

- [ ] **Step 5: Wait for background detection on the old tab**

Expected: `立即更新` appears on `Me` without any manual “check update” action.

- [ ] **Step 6: Click `立即更新` and confirm the version switch**

Expected:

- the page refreshes into the new real implementation build
- the update button disappears afterward if no newer build exists

- [ ] **Step 7: Verify the no-update baseline**

Refresh again with no newer build available.
Expected: `立即更新` does not appear.

- [ ] **Step 8: Note manual coverage limits in the handoff if needed**

If the timeout or stale flow cannot be reproduced manually, leave them covered by unit tests and note that explicitly in the handoff.

## Notes For The Implementer

- Keep the provider API tiny. Do not expose `checkForUpdate()` to pages.
- Do not add a version badge, settings-page variant, or manual “检查更新” button.
- Reuse Sonner for stale/failure feedback inside the provider so `MePage` stays presentation-only.
- Follow the existing provider pattern in `packages/web/src/hooks/use-pwa-install.tsx`: local context, explicit hook guard, focused memoized value.
- Prefer mocking `useRegisterSW` in tests rather than simulating a real browser service worker lifecycle in jsdom.
