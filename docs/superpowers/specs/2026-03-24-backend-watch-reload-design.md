# Backend Watch Reload

## Summary

Improve local backend development experience by making the server process restart automatically when TypeScript source files change. ReMi already starts the backend with `tsx`, so the simplest compatible upgrade is to switch the backend dev command from one-shot `tsx` execution to `tsx watch` while keeping the frontend Vite flow unchanged.

## Motivation

Right now `dev.sh` starts the backend once and leaves it running until the developer stops and restarts the script manually. That adds friction to normal backend work: route edits, prompt changes, engine changes, and database-layer changes all require a manual restart before they take effect.

The goal here is not to redesign the dev stack. It is to remove a repetitive interruption from the existing loop with the smallest possible change.

## Goals

- Restart the backend automatically when backend TypeScript source changes
- Preserve the current `dev.sh` entrypoint for day-to-day development
- Keep the frontend Vite dev server behavior unchanged
- Avoid introducing an additional watcher tool if `tsx` already covers the need

## Non-Goals

- Server-side HMR without process restart
- A broader dev-process supervisor redesign
- Changes to production startup commands
- Changing the frontend dev server or proxy architecture

## Current State

The current developer entrypoint is `dev.sh`.

- `dev.sh` starts the backend with `npx tsx packages/server/src/index.ts`
- `dev.sh` starts the frontend separately with `npm run dev --prefix packages/web`
- If backend code changes, the running server does not reload automatically

This means the existing setup already depends on `tsx`; it just is not using its watch mode.

## Proposed Approach

Switch the backend launch command in `dev.sh` to `npx tsx watch packages/server/src/index.ts`.

### Why this approach

- It matches the existing backend runtime tool instead of adding another layer such as `nodemon`
- It keeps the change local to development workflow code
- It minimizes new configuration and new failure modes
- It is easy to reason about: source changes trigger a full backend process restart

## Alternatives Considered

### 1. `tsx watch` (recommended)

- Lowest implementation cost
- No new dev dependency required
- Matches the current ESM + TypeScript runtime path
- Good enough for backend development where full restart is acceptable

### 2. `nodemon` wrapping `tsx`

- More configurable for ignore patterns and custom watch scopes
- Adds another process-management layer and more config surface
- Not justified for the current need

### 3. A broader process supervisor migration

- Could unify logging, restarts, and multi-process orchestration
- Much larger scope than the actual problem
- Risks turning a small DX improvement into toolchain churn

## Developer Workflow After Change

The normal workflow remains the same:

```bash
npm run dev
```

Expected behavior:

- frontend Vite server still starts as before
- backend server starts in watch mode
- editing backend entrypoint files or loaded backend modules causes the backend process to restart automatically
- editing frontend files continues to rely on Vite's existing dev behavior

## Scope Boundary

The initial implementation should stay as small as possible.

In scope:

- `dev.sh` backend command update
- preserving or restoring a reliable backend startup failure signal in watch mode
- optional script naming cleanup in `package.json` only if it improves clarity without changing the main entrypoint
- verification that backend restarts and frontend remains unaffected

Out of scope:

- adding file ignore rules unless a concrete watch-loop problem is observed
- custom watcher config files
- runtime state preservation across restarts

## Verification Plan

At minimum, verify the following manually:

1. Run `npm run dev`
2. Confirm both backend and frontend processes start successfully
3. Confirm the script still reports backend boot failure if the watched backend process crashes on startup
4. Edit a backend file such as `packages/server/src/index.ts`
5. Confirm the backend process restarts automatically
6. Confirm the frontend Vite process stays up during backend restart

The implementation must not silently treat the backend as healthy just because the `tsx watch` parent process is alive. A minimal readiness or failure check is required so `npm run dev` still fails loudly when the backend cannot boot.

If a repository test is added for the script or command shape, it should only assert the intended startup contract and should avoid overfitting to shell formatting.

## Risks and Mitigations

### Risk: watch mode restarts on too many files

Mitigation: start with default `tsx watch` behavior. Only add scope narrowing if a real watch loop or noisy restart pattern appears.

### Risk: backend startup logs become noisier

Mitigation: acceptable trade-off for local development. This change affects dev ergonomics only.

### Risk: future contributors assume this is HMR

Mitigation: document clearly that this is process restart, not state-preserving hot module replacement.

### Risk: watch parent stays alive while backend child is broken

Mitigation: keep an explicit backend readiness or crash-detection check in `dev.sh` so startup still fails loudly when the watched server cannot boot.

## Acceptance Criteria

- `npm run dev` still works as the main local development command
- backend entrypoint or loaded module edits trigger automatic backend restart
- frontend dev behavior remains unchanged
- no new watcher dependency is introduced just to support backend reload
- startup still fails loudly when the backend cannot boot under watch mode
