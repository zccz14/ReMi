# Public Profile UI Coverage Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make public profile identity show up consistently across Chat, Contacts, Messages, and Me using existing profile APIs and deterministic fallbacks.

**Architecture:** Add a thin web-side profile resolver plus in-memory dedupe cache for public-profile reads, extend the shared avatar/header primitives just enough to render resolved avatar + nickname, and update the four target pages to enrich existing layouts without changing their core navigation or data sources. Keep `MePage` on the owner profile endpoint, and keep Contacts grouping/order based on the existing raw `pubKey` logic.

**Tech Stack:** TypeScript, React 19, Vite, Vitest, Testing Library

---

## File Structure

- Modify: `packages/web/src/lib/profile.ts`
  - Add a thin resolved-profile mapping helper and a small session-local public-profile cache.
- Create: `packages/web/test/lib/profile.test.ts`
  - Cover resolved display name, bio trimming, avatar URL mapping, fetch fallback, and cache behavior.
- Modify: `packages/web/src/components/chat/ChatAvatar.tsx`
  - Add optional image rendering with local fallback to the generated avatar.
- Create: `packages/web/test/components/chat/ChatAvatar.test.tsx`
  - Cover `src` rendering, fallback rendering, and image error fallback.
- Modify: `packages/web/src/components/layout/FullScreenLayout.tsx`
  - Widen `title` from `string` to `ReactNode` so the chat header can render avatar + nickname.
- Modify: `packages/web/src/pages/AvatarChatPage.tsx`
  - Load counterpart public profile and render avatar + nickname in the header, with no bio.
- Modify: `packages/web/src/pages/ContactsPage.tsx`
  - Enrich each row with nickname + avatar while preserving current grouping/order behavior.
- Modify: `packages/web/src/pages/MessagesPage.tsx`
  - Enrich avatar conversations with nickname + avatar while keeping ReMi unchanged.
- Modify: `packages/web/src/pages/MePage.tsx`
  - Load owner profile and render nickname + avatar + bio in the top card.
- Create: `packages/web/test/components/layout/FullScreenLayout.test.tsx`
  - Cover `title` accepting `ReactNode` without changing the existing back button/header layout.
- Create: `packages/web/test/pages/AvatarChatPage.test.tsx`
  - Cover nickname/avatar header enrichment and fallback behavior.
- Create: `packages/web/test/pages/ContactsPage.test.tsx`
  - Cover nickname/avatar row enrichment and preserved grouping/order.
- Create: `packages/web/test/pages/MessagesPage.test.tsx`
  - Cover avatar conversation enrichment, ReMi unchanged, and fallback behavior.
- Create: `packages/web/test/pages/MePage.test.tsx`
  - Cover owner profile rendering, bio omission when empty, and fallback behavior.

## Chunk 1: Shared Profile Resolution

### Task 1: Add failing tests for resolved public-profile mapping

**Files:**

- Create: `packages/web/test/lib/profile.test.ts`
- Modify: `packages/web/src/lib/profile.ts`

- [ ] **Step 1: Write the failing resolver tests**

```ts
it("maps public profile data to a UI-ready identity shape", async () => {
  const result = resolveProfileSummary("abcdef1234567890", {
    displayName: "Nova",
    bio: "  hello  ",
    hasAvatar: true,
    avatarVersion: 7,
    updatedAt: 1,
  });

  expect(result).toMatchObject({
    pubKey: "abcdef1234567890",
    displayName: "Nova",
    bio: "hello",
    avatarUrl: `${API_BASE}/api/public/abcdef1234567890/profile/avatar?v=7`,
  });
});

it("falls back to truncated pubKey and no bio/avatar when profile is empty", async () => {
  const result = resolveProfileSummary("abcdef1234567890", emptyPublicProfile);
  expect(result.displayName).toBe("abcdef...7890");
  expect(result.bio).toBe("");
  expect(result.avatarUrl).toBeNull();
});
```

- [ ] **Step 2: Run the new resolver test file to verify failure**

Run: `npm test -- packages/web/test/lib/profile.test.ts`
Expected: FAIL because the resolver helpers do not exist yet.

- [ ] **Step 3: Add failing tests for fetch fallback and dedupe cache behavior**

```ts
it("falls back to empty profile semantics when public profile fetch fails", async () => {
  global.fetch = vi.fn().mockRejectedValue(new Error("boom"));
  const result = await loadPublicProfileSummary("abcdef1234567890");
  expect(result.displayName).toBe("abcdef...7890");
  expect(result.avatarUrl).toBeNull();
});

it("reuses the in-memory result for the same pubKey within one session", async () => {
  global.fetch = vi.fn().mockResolvedValue(okProfileResponse({ displayName: "Nova" }));
  await loadPublicProfileSummary("abcdef1234567890");
  await loadPublicProfileSummary("abcdef1234567890");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("clears cached state between tests", async () => {
  clearPublicProfileCache();
  global.fetch = vi.fn().mockResolvedValue(okProfileResponse({ displayName: "Nova" }));
  await loadPublicProfileSummary("abcdef1234567890");
  clearPublicProfileCache();
  await loadPublicProfileSummary("abcdef1234567890");
  expect(fetch).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 4: Re-run the resolver tests and confirm the failure reason**

Run: `npm test -- packages/web/test/lib/profile.test.ts`
Expected: FAIL with missing exports or wrong shape mismatches.

### Task 2: Implement the thin profile resolver

**Files:**

- Modify: `packages/web/src/lib/profile.ts`
- Test: `packages/web/test/lib/profile.test.ts`

- [ ] **Step 1: Add the UI-facing resolved type and pure mapping helper**

```ts
export interface ResolvedProfileSummary {
  pubKey: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
}

export function resolveProfileSummary(
  pubKey: string,
  profile: PublicProfile,
): ResolvedProfileSummary {
  const bio = profile.bio.trim();
  return {
    pubKey,
    displayName: getFallbackDisplayName(pubKey, profile.displayName),
    bio,
    avatarUrl: profile.hasAvatar ? buildAvatarUrl(pubKey, profile.avatarVersion) : null,
  };
}
```

- [ ] **Step 2: Add a minimal shared async loader with session-local dedupe cache**

Also add a tiny cache reset export for tests so page and lib tests can isolate module-level state.

```ts
const publicProfileCache = new Map<string, Promise<ResolvedProfileSummary>>();

export function clearPublicProfileCache() {
  publicProfileCache.clear();
}

export function loadPublicProfileSummary(pubKey: string): Promise<ResolvedProfileSummary> {
  if (!publicProfileCache.has(pubKey)) {
    publicProfileCache.set(pubKey, fetchProfileSummary(pubKey));
  }
  return publicProfileCache.get(pubKey)!;
}
```

- [ ] **Step 3: Ensure fetch failure resolves to fallback identity instead of rejecting**

```ts
async function fetchProfileSummary(pubKey: string): Promise<ResolvedProfileSummary> {
  try {
    const response = await fetch(buildPublicProfileUrl(pubKey));
    if (!response.ok) return resolveProfileSummary(pubKey, emptyPublicProfile);
    const payload = (await response.json()) as { data?: PublicProfile };
    return resolveProfileSummary(pubKey, payload.data ?? emptyPublicProfile);
  } catch {
    return resolveProfileSummary(pubKey, emptyPublicProfile);
  }
}
```

- [ ] **Step 4: Run the resolver tests to verify they pass**

Run: `npm test -- packages/web/test/lib/profile.test.ts`
Expected: PASS

## Chunk 2: Shared Avatar And Layout Primitives

### Task 3: Add failing tests for image-backed `ChatAvatar`

**Files:**

- Create: `packages/web/test/components/chat/ChatAvatar.test.tsx`
- Modify: `packages/web/src/components/chat/ChatAvatar.tsx`

- [ ] **Step 1: Write failing tests for image rendering and fallback**

```tsx
it("renders an image when src is provided", () => {
  render(<ChatAvatar pubKey="abcdef1234567890" name="Nova" src="/avatar.webp" />);
  expect(screen.getByRole("img", { name: "Nova" })).toHaveAttribute("src", "/avatar.webp");
});

it("falls back to generated avatar after image load failure", async () => {
  render(<ChatAvatar pubKey="abcdef1234567890" name="Nova" src="/avatar.webp" />);
  fireEvent.error(screen.getByRole("img", { name: "Nova" }));
  expect(await screen.findByText("N")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the avatar test file to verify failure**

Run: `npm test -- packages/web/test/components/chat/ChatAvatar.test.tsx`
Expected: FAIL because `src` support does not exist yet.

- [ ] **Step 3: Implement optional image rendering while preserving size, radius, and clickability**

```tsx
export function ChatAvatar({ pubKey, name, src, size = "md", onClick }: ChatAvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const canShowImage = Boolean(src) && !imageFailed;
  return (
    <div role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined}>
      {canShowImage ? (
        <img
          src={src}
          alt={name ?? pubKey}
          onError={() => setImageFailed(true)}
          style={{ width: px, height: px, borderRadius: radius }}
        />
      ) : (
        <div>{displayText}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Re-run the avatar test file to verify it passes**

Run: `npm test -- packages/web/test/components/chat/ChatAvatar.test.tsx`
Expected: PASS

### Task 4: Add the minimal `FullScreenLayout` title widening

**Files:**

- Modify: `packages/web/src/components/layout/FullScreenLayout.tsx`
- Create: `packages/web/test/components/layout/FullScreenLayout.test.tsx`

- [ ] **Step 1: Add a runtime smoke test for non-string header content after the type change**

```tsx
render(<FullScreenLayout title={<span>custom-title</span>}>body</FullScreenLayout>);
expect(screen.getByText("custom-title")).toBeInTheDocument();
```

- [ ] **Step 2: Run the affected test file to verify failure**

- [ ] **Step 2: Widen `title` from `string` to `ReactNode` with no layout behavior changes**

```tsx
interface FullScreenLayoutProps {
  title: ReactNode;
  children: ReactNode;
  onBack?: () => void;
}
```

- [ ] **Step 3: Run the layout test file to verify the runtime smoke test passes**

Run: `npm test -- packages/web/test/components/layout/FullScreenLayout.test.tsx`
Expected: PASS

## Chunk 3: Page-Level UI Coverage

### Task 5: Add failing tests for `AvatarChatPage` header enrichment

**Files:**

- Create: `packages/web/test/pages/AvatarChatPage.test.tsx`
- Modify: `packages/web/src/pages/AvatarChatPage.tsx`

Define any test helpers locally in this file using existing `renderWithProviders` patterns; do not assume shared helpers already exist.

- [ ] **Step 1: Write failing tests for nickname/avatar rendering in chat header**

```tsx
it("shows public nickname and avatar in the chat header", async () => {
  mockPublicProfileFetch({ displayName: "Nova", hasAvatar: true, avatarVersion: 3 });
  renderAvatarChatPage("/chat/abcdef1234567890");
  expect(await screen.findByText("Nova")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Nova" })).toHaveAttribute(
    "src",
    `${API_BASE}/api/public/abcdef1234567890/profile/avatar?v=3`,
  );
  expect(screen.queryByText("hello")).not.toBeInTheDocument();
});

it("falls back to truncated pubKey and generated avatar when profile load fails", async () => {
  mockPublicProfileFailure();
  renderAvatarChatPage("/chat/abcdef1234567890");
  expect(await screen.findByText("abcdef...7890")).toBeInTheDocument();
  expect(screen.getByText("A")).toBeInTheDocument();
});

it("keeps avatar click navigation to /profile/:pubKey", async () => {
  mockPublicProfileFetch({ displayName: "Nova" });
  renderWithProviders(
    <Routes>
      <Route path="/chat/:pubKey" element={<AvatarChatPage />} />
      <Route path="/profile/:pubKey" element={<div>profile-route</div>} />
    </Routes>,
    { route: "/chat/abcdef1234567890" },
  );
  await userEvent.setup().click(await screen.findByRole("button", { name: "Nova" }));
  expect(await screen.findByText("profile-route")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the new chat-page test file to verify failure**

Run: `npm test -- packages/web/test/pages/AvatarChatPage.test.tsx`
Expected: FAIL because header enrichment does not exist yet.

- [ ] **Step 3: Implement minimal profile load and compact header rendering**

```tsx
const [summary, setSummary] = useState(() =>
  resolveProfileSummary(pubKey ?? "", emptyPublicProfile),
);

useEffect(() => {
  if (!pubKey) return;
  let active = true;
  void loadPublicProfileSummary(pubKey).then((next) => {
    if (active) setSummary(next);
  });
  return () => {
    active = false;
  };
}, [pubKey]);
```

- [ ] **Step 4: Re-run the chat-page test file to verify it passes**

Run: `npm test -- packages/web/test/pages/AvatarChatPage.test.tsx`
Expected: PASS

### Task 6: Add failing tests for `ContactsPage` enrichment without reordering

**Files:**

- Create: `packages/web/test/pages/ContactsPage.test.tsx`
- Modify: `packages/web/src/pages/ContactsPage.tsx`

Define any test helpers locally in this file using existing `renderWithProviders` patterns; do not assume shared helpers already exist.

- [ ] **Step 1: Write failing tests for nickname/avatar rows and stable grouping/order**

```tsx
it("shows resolved nickname and avatar for each contact", async () => {
  mockContacts([{ pubKey: "b-key-1234567890" }, { pubKey: "a-key-1234567890" }]);
  mockProfile("b-key-1234567890", { displayName: "Nova" });
  mockProfile("a-key-1234567890", { displayName: "Ada", hasAvatar: true, avatarVersion: 1 });
  renderContactsPage();
  expect(await screen.findByText("Nova")).toBeInTheDocument();
  expect(await screen.findByText("Ada")).toBeInTheDocument();
  expect(screen.queryByText("hello")).not.toBeInTheDocument();
});

it("preserves the existing raw-pubKey grouping/order while rows are enriched", async () => {
  renderContactsPage();
  expect(await screen.findAllByRole("button")).toHaveLength(2);
  expect(screen.getAllByRole("button")[0]).toHaveTextContent("a-key");
  expect(screen.getAllByRole("button")[1]).toHaveTextContent("b-key");
});
```

- [ ] **Step 2: Run the contacts-page test file to verify failure**

Run: `npm test -- packages/web/test/pages/ContactsPage.test.tsx`
Expected: FAIL because profile enrichment does not exist yet.

- [ ] **Step 3: Implement row-level profile enrichment without changing grouping/order logic**

```tsx
const [profiles, setProfiles] = useState<Record<string, ResolvedProfileSummary>>({});

useEffect(() => {
  const pubKeys = [...new Set(contacts.map((contact) => contact.pubKey))];
  let active = true;

  void Promise.all(
    pubKeys.map(async (pubKey) => [pubKey, await loadPublicProfileSummary(pubKey)] as const),
  ).then((entries) => {
    if (active) setProfiles(Object.fromEntries(entries));
  });

  return () => {
    active = false;
  };
}, [contacts]);
```

- [ ] **Step 4: Re-run the contacts-page test file to verify it passes**

Run: `npm test -- packages/web/test/pages/ContactsPage.test.tsx`
Expected: PASS

### Task 7: Add failing tests for `MessagesPage` enrichment and ReMi stability

**Files:**

- Create: `packages/web/test/pages/MessagesPage.test.tsx`
- Modify: `packages/web/src/pages/MessagesPage.tsx`

Define any test helpers locally in this file using existing `renderWithProviders` patterns; do not assume shared helpers already exist.

- [ ] **Step 1: Write failing tests for avatar conversations using public profile identity**

```tsx
it("shows public nickname for avatar conversations", async () => {
  mockConversations([
    { type: "avatar", pubKey: "abcdef1234567890", lastMessage: "hi", lastMessageAt: 1 },
  ]);
  mockProfile("abcdef1234567890", { displayName: "Nova" });
  renderMessagesPage();
  expect(await screen.findByText("Nova")).toBeInTheDocument();
  expect(screen.queryByText("hello")).not.toBeInTheDocument();
});

it("keeps the ReMi conversation name unchanged", async () => {
  mockConversations([{ type: "remi", lastMessage: "hello", lastMessageAt: 1 }]);
  renderMessagesPage();
  expect(await screen.findByText("ReMi")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the messages-page test file to verify failure**

Run: `npm test -- packages/web/test/pages/MessagesPage.test.tsx`
Expected: FAIL because avatar conversations still render truncated `pubKey` only.

- [ ] **Step 3: Implement avatar-conversation enrichment while preserving preview/timestamp layout**

```tsx
const [profiles, setProfiles] = useState<Record<string, ResolvedProfileSummary>>({});

useEffect(() => {
  const pubKeys = [
    ...new Set(
      conversations
        .filter((item) => item.type === "avatar" && item.pubKey)
        .map((item) => item.pubKey!),
    ),
  ];

  if (pubKeys.length === 0) {
    setProfiles({});
    return;
  }

  let active = true;

  void Promise.all(
    pubKeys.map(async (pubKey) => [pubKey, await loadPublicProfileSummary(pubKey)] as const),
  ).then((entries) => {
    if (active) setProfiles(Object.fromEntries(entries));
  });

  return () => {
    active = false;
  };
}, [conversations]);

const profile = item.pubKey ? profiles[item.pubKey] : null;
const name =
  item.type === "remi" ? "ReMi" : (profile?.displayName ?? truncatePubKey(item.pubKey ?? ""));
const avatarSrc = item.type === "avatar" ? (profile?.avatarUrl ?? undefined) : undefined;
```

- [ ] **Step 4: Re-run the messages-page test file to verify it passes**

Run: `npm test -- packages/web/test/pages/MessagesPage.test.tsx`
Expected: PASS

### Task 8: Add failing tests for `MePage` owner-profile rendering

**Files:**

- Create: `packages/web/test/pages/MePage.test.tsx`
- Modify: `packages/web/src/pages/MePage.tsx`

Define any test helpers locally in this file using existing `renderWithProviders` patterns; do not assume shared helpers already exist.

- [ ] **Step 1: Write failing tests for owner nickname/avatar/bio rendering**

```tsx
it("shows owner nickname, avatar, and bio on the me card", async () => {
  mockOwnerProfile({ displayName: "Nova", bio: "hello", hasAvatar: true, avatarVersion: 4 });
  renderMePage();
  expect(await screen.findByText("Nova")).toBeInTheDocument();
  expect(screen.getByText("hello")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Nova" })).toHaveAttribute(
    "src",
    `${API_BASE}/api/public/mock-public-key/profile/avatar?v=4`,
  );
});

it("falls back to truncated owner pubKey and hides bio when owner profile is empty", async () => {
  mockOwnerProfile(emptyPublicProfile);
  renderMePage();
  expect(await screen.findByText("mock-p...-key")).toBeInTheDocument();
  expect(screen.queryByText("hello")).not.toBeInTheDocument();
});

it("falls back to truncated owner pubKey and no bio when owner profile load fails", async () => {
  mockOwnerProfileFailure();
  renderMePage();
  expect(await screen.findByText("mock-p...-key")).toBeInTheDocument();
  expect(screen.queryByText("hello")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the me-page test file to verify failure**

Run: `npm test -- packages/web/test/pages/MePage.test.tsx`
Expected: FAIL because `MePage` does not load owner profile yet.

- [ ] **Step 3: Implement owner-profile loading and card enrichment**

```tsx
useEffect(() => {
  let active = true;

  void apiClient
    .get<{ data: PublicProfile }>(apiClient.ownerPath("/profile"))
    .then((res) => {
      if (active) setSummary(resolveProfileSummary(publicKey, res.data));
    })
    .catch(() => {
      if (active) setSummary(resolveProfileSummary(publicKey, emptyPublicProfile));
    });

  return () => {
    active = false;
  };
}, [apiClient, publicKey]);
```

- [ ] **Step 4: Re-run the me-page test file to verify it passes**

Run: `npm test -- packages/web/test/pages/MePage.test.tsx`
Expected: PASS

## Chunk 4: Final Verification

### Task 9: Run the focused web test suite

**Files:**

- Test: `packages/web/test/lib/profile.test.ts`
- Test: `packages/web/test/components/chat/ChatAvatar.test.tsx`
- Test: `packages/web/test/components/layout/FullScreenLayout.test.tsx`
- Test: `packages/web/test/pages/AvatarChatPage.test.tsx`
- Test: `packages/web/test/pages/ContactsPage.test.tsx`
- Test: `packages/web/test/pages/MessagesPage.test.tsx`
- Test: `packages/web/test/pages/MePage.test.tsx`

- [ ] **Step 1: Run the focused test files together**

Run: `npm test -- packages/web/test/lib/profile.test.ts packages/web/test/components/chat/ChatAvatar.test.tsx packages/web/test/components/layout/FullScreenLayout.test.tsx packages/web/test/pages/AvatarChatPage.test.tsx packages/web/test/pages/ContactsPage.test.tsx packages/web/test/pages/MessagesPage.test.tsx packages/web/test/pages/MePage.test.tsx`
Expected: PASS

- [ ] **Step 2: Run the broader web test suite if the repo has a standard command**

Run: `npm test -- packages/web/test`
Expected: PASS

- [ ] **Step 3: Review the changed UI surfaces manually in the browser if local app startup is available**

Run: `npm run dev`
Expected: Chat, Contacts, Messages, and Me render enriched identity correctly, with stable fallback behavior.

- [ ] **Step 4: Commit once verification is green**

```bash
git add packages/web/src/lib/profile.ts \
  packages/web/src/components/chat/ChatAvatar.tsx \
  packages/web/src/components/layout/FullScreenLayout.tsx \
  packages/web/src/pages/AvatarChatPage.tsx \
  packages/web/src/pages/ContactsPage.tsx \
  packages/web/src/pages/MessagesPage.tsx \
  packages/web/src/pages/MePage.tsx \
  packages/web/test/lib/profile.test.ts \
  packages/web/test/components/chat/ChatAvatar.test.tsx \
  packages/web/test/components/layout/FullScreenLayout.test.tsx \
  packages/web/test/pages/AvatarChatPage.test.tsx \
  packages/web/test/pages/ContactsPage.test.tsx \
  packages/web/test/pages/MessagesPage.test.tsx \
  packages/web/test/pages/MePage.test.tsx

git commit -m "fix: expand public profile coverage across core pages"
```
