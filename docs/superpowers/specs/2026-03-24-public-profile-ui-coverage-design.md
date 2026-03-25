# Public Profile UI Coverage Design

## Summary

Extend public-profile usage across the main user-facing surfaces so nickname, avatar, and bio are shown consistently where they matter.

This change covers four pages only:

- Chat: show nickname and avatar for the chat counterpart
- Contacts: show nickname and avatar for each contact
- Messages: show nickname and avatar for each conversation
- Me: show nickname, avatar, and bio for the current user

The fallback rule is fixed across all pages: if profile data is missing or fails to load, show truncated `pubKey` as the name, use the existing generated avatar, and omit `bio` entirely.

## Motivation

The project already has a working public-profile model and APIs, but that information is only surfaced in limited places. In daily use, users mostly interact through chat lists, contacts, and the Me page. If those surfaces still show raw keys while the share/profile page shows richer identity, the product feels inconsistent and incomplete.

The goal here is not to redesign profile features, but to make public identity feel present across the app using the existing profile system.

## Scope

### In Scope

- Reuse existing public-profile APIs from the web app
- Add a shared profile-summary loading layer for UI consumption
- Show nickname + avatar on `AvatarChatPage`
- Show nickname + avatar on `MessagesPage`
- Show nickname + avatar on `ContactsPage`
- Show nickname + avatar + bio on `MePage`
- Keep deterministic fallback behavior when profile data is unavailable
- Add frontend tests for the new rendering and fallback rules

### Out of Scope

- Backend schema or API changes
- Showing bio on Chat, Contacts, or Messages pages
- Changing ReMi branding or ReMi avatar behavior
- Adding profile editing to new pages
- Global state library adoption
- Server-side profile aggregation into conversations or contacts APIs

## Existing State

### Profile primitives already exist

- `packages/web/src/lib/profile.ts` already defines `PublicProfile`, `buildPublicProfileUrl`, `buildAvatarUrl`, and `getFallbackDisplayName`
- `packages/server/src/routes/public-profile.ts` already exposes public profile read APIs
- `packages/server/src/routes/profile.ts` already exposes owner profile read/write APIs

### UI coverage is incomplete

- `packages/web/src/pages/AvatarChatPage.tsx` uses truncated `pubKey` in the header and generated avatars only
- `packages/web/src/pages/ContactsPage.tsx` only receives `pubKey` and renders truncated `pubKey`
- `packages/web/src/pages/MessagesPage.tsx` only receives `pubKey` and renders truncated `pubKey`
- `packages/web/src/pages/MePage.tsx` shows avatar plus truncated owner `pubKey`, but does not load owner public profile at all

This means the app has profile data, but does not treat it as a first-class presentation layer.

## Design Principles

1. **Centralize profile presentation rules**: loading, fallback, and avatar URL logic should not be duplicated across pages.
2. **Prefer graceful degradation**: profile failures must never block navigation or chat usage.
3. **Do not expand product scope**: this is a presentation coverage fix, not a profile-system redesign.
4. **Preserve current page structure**: integrate profile data into existing layouts instead of redesigning the app.
5. **Keep list pages responsive**: render the page immediately and hydrate profile data asynchronously.

## Recommended Approach

Use a small shared frontend profile-summary resolver that resolves display data by `pubKey`, caches results in memory, and exposes a UI-ready shape.

Why this approach:

- It fixes the root cause: profile presentation is currently page-local and inconsistent.
- It avoids repeated ad hoc fetch logic in `MessagesPage`, `ContactsPage`, and `AvatarChatPage`, while letting `MePage` keep using the owner profile endpoint.
- It keeps backend scope small because existing APIs are already sufficient.
- It stays small and targeted to the four pages in scope.

Rejected alternatives:

### 1. Page-by-page direct fetches

Each page fetches its own public profile data independently.

- Pros: smallest local code change per page
- Cons: duplicated fallback logic, duplicated loading logic, repeated requests, and higher chance of future inconsistency

### 2. Backend-enriched contacts / conversations endpoints

Extend `/contacts` and `/conversations` to return profile data directly.

- Pros: fewer frontend round trips for those two pages
- Cons: wider API changes, still does not solve `AvatarChatPage` and `MePage` uniformly, and spreads profile logic across unrelated endpoints

## Data Model For UI Consumption

Add a thin frontend view model for resolved identity data used only by the four pages in scope.

Suggested shape:

```ts
interface ResolvedProfileSummary {
  pubKey: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
}
```

Behavior:

- `displayName` is already fallback-resolved for UI use
- `bio` is trimmed
- `avatarUrl` is resolved only when `hasAvatar` is true; otherwise `null`

## Frontend Loading Layer

### Shared public-profile resolution

Create a shared helper or hook that, given a `pubKey`, fetches `GET /api/public/:pubKey/profile` and returns a `ResolvedProfileSummary`.

This helper is a thin resolver plus in-memory dedupe cache for the four pages in scope, not a generic profile framework.

Failure behavior:

- Any fetch error falls back to an empty profile state
- UI still resolves `displayName` from `getFallbackDisplayName(pubKey, "")`
- UI still uses generated avatar when `avatarUrl` is `null`

For list pages, the shared resolver may be called repeatedly for multiple `pubKey`s, but it should deduplicate through a session-local in-memory cache. No persistence is needed.

Requirements:

- Deduplicate duplicate `pubKey`s before issuing network requests where practical
- Preserve already loaded results across rerenders within the session
- Do not block initial page render on profile fetch completion
- Ignore stale responses after the consumer changes or unmounts

## Page-Level Design

### 1. Chat Page (`packages/web/src/pages/AvatarChatPage.tsx`)

Current state:

- Header title is truncated `pubKey`
- Counterpart avatar is generated from `pubKey`

Target behavior:

- Header title shows resolved nickname first, truncated `pubKey` as fallback
- Counterpart avatar shows public avatar when available, generated avatar otherwise
- Do not show bio in chat header
- Clicking the counterpart avatar still navigates to `/profile/:pubKey`

Implementation note:

- `FullScreenLayout` currently only supports a string title. It should be widened to accept `ReactNode` so chat can render a compact avatar + nickname cluster in the center header area.
- The header should remain visually compact; no second line is needed.

### 2. Contacts Page (`packages/web/src/pages/ContactsPage.tsx`)

Current state:

- Each row shows generated avatar plus truncated `pubKey`
- Grouping uses first character of raw `pubKey`

Target behavior:

- Each row shows resolved nickname first, truncated `pubKey` as fallback
- Each row shows public avatar when available, generated avatar otherwise
- Do not show bio
- Keep the current grouping and ordering behavior; this task only changes what each row displays

Fallback implications:

- Contacts without a nickname still display truncated `pubKey`
- Existing ordering and grouping stay stable even while profile data hydrates asynchronously

### 3. Messages Page (`packages/web/src/pages/MessagesPage.tsx`)

Current state:

- Avatar conversations show generated avatar plus truncated `pubKey`
- Preview layout already shows name, message preview, and timestamp

Target behavior:

- Avatar conversations show resolved nickname first, truncated `pubKey` as fallback
- Avatar conversations show public avatar when available, generated avatar otherwise
- ReMi conversation remains special-cased and unchanged
- Do not show bio
- Keep last-message preview and timestamp layout intact

Loading behavior:

- Conversation list should render immediately from `/conversations`
- Profile enrichment should update rows once profile data arrives

### 4. Me Page (`packages/web/src/pages/MePage.tsx`)

Current state:

- Top card shows generated avatar and truncated owner `pubKey`
- No nickname or bio is loaded

Target behavior:

- Top card shows owner nickname first, truncated owner `pubKey` as fallback
- Top card shows public avatar when available, generated avatar otherwise
- Top card shows bio only when non-empty
- This page should use the owner profile endpoint rather than the public endpoint so first-run owner bootstrap remains correct

Why owner endpoint here:

- `MePage` is showing the current user's editable public identity
- Owner profile loading is already the canonical source for self-view in authenticated surfaces
- It avoids edge cases around public-route availability and keeps self-profile initialization aligned with `SettingsPage`

## Component Changes

### `ChatAvatar`

`ChatAvatar` should be extended to optionally render an image source when available, while preserving current deterministic fallback rendering.

Suggested behavior:

- New optional `src` prop
- If `src` loads successfully, show the image
- If the image fails or `src` is missing, fall back to the current generated avatar behavior
- Preserve sizes and clickability

This avoids creating parallel avatar components for essentially the same UI role.

### `FullScreenLayout`

`FullScreenLayout` should widen `title` from `string` to `ReactNode`.

This allows `AvatarChatPage` to render the counterpart avatar and nickname in the header without creating a one-off layout component or introducing a broader header-slot API.

## Error Handling

- Public profile fetch failure on Chat / Contacts / Messages must not show blocking errors
- These surfaces should silently fall back to current key-based identity rendering
- Owner profile fetch failure on Me page may continue to show the current toast or common error behavior if desired, but the visible card should still degrade to fallback identity rather than appearing broken
- Avatar image load failures must fall back locally to generated avatars without retry loops

## Testing Strategy

Follow TDD for the behavior change.

### Test coverage targets

1. Profile-summary resolver

- Resolves nickname, bio, and avatar URL from profile payload
- Falls back correctly when the payload is empty
- Falls back correctly when fetch fails

2. `ChatAvatar`

- Renders generated fallback when `src` is absent
- Renders image when `src` is provided
- Falls back to generated avatar after image load failure

3. `AvatarChatPage`

- Uses resolved nickname in the header
- Keeps bio hidden
- Falls back to truncated `pubKey` when profile load fails

4. `ContactsPage`

- Renders resolved nickname in rows
- Keeps bio hidden
- Preserves the current grouping and ordering behavior while profile data hydrates

5. `MessagesPage`

- Renders resolved nickname for avatar conversations
- Leaves ReMi conversation unchanged
- Keeps bio hidden and preserves last-message preview

6. `MePage`

- Renders owner nickname, avatar, and bio from owner profile
- Falls back to truncated owner `pubKey` and generated avatar when owner profile is empty or fails

## Risks And Mitigations

### Risk: too many duplicate profile requests

Mitigation:

- Deduplicate `pubKey`s before loading
- Cache results in memory per session

### Risk: list flicker as names hydrate after initial render

Mitigation:

- Use deterministic fallback names immediately
- Replace with resolved nicknames as data arrives
- Avoid loading spinners inside every row

### Risk: inconsistent Contacts behavior while profile data hydrates

Mitigation:

- Keep Contacts grouping and ordering based on the existing raw `pubKey` behavior
- Use profile data only to enrich each row's displayed name and avatar

## Acceptance Criteria

- `AvatarChatPage` shows counterpart nickname and avatar from public profile when available
- `ContactsPage` shows nickname and avatar for contacts when available
- `MessagesPage` shows nickname and avatar for avatar conversations when available
- `MePage` shows owner nickname, avatar, and bio when available
- Chat, Contacts, and Messages pages do not show bio
- Missing or failed profile loads always fall back to truncated `pubKey` + generated avatar, with no bio shown
- ReMi rendering stays unchanged
- New tests cover both resolved and fallback rendering paths
