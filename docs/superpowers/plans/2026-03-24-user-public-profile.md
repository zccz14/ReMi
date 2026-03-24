# User Public Profile Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add editable public profile settings with public nickname/bio/avatar, plus a shareable public profile page backed by per-user SQLite storage.

**Architecture:** Extend the existing per-user SQLite schema with dedicated `public_profile` and `public_profile_avatar` tables, add owner and public Hono routes for profile reads/writes, extend the signed web API client for binary avatar upload, and upgrade the settings/profile pages to support profile editing plus canvas-based square avatar cropping.

**Tech Stack:** TypeScript, Hono, better-sqlite3, Drizzle, React 19, Vite, Vitest, Testing Library

---

## File Structure

- Modify: `packages/server/src/db/migrate.ts`
  - Add idempotent schema bootstrap for `public_profile` and `public_profile_avatar`.
- Modify: `packages/server/src/db/schema.ts`
  - Add Drizzle table definitions for profile text and avatar blob storage.
- Create: `packages/server/src/routes/profile.ts`
  - Owner-authenticated profile read/write/avatar routes.
- Create: `packages/server/src/routes/public-profile.ts`
  - Unauthenticated public profile/avatar routes with explicit `pubKey` validation.
- Modify: `packages/server/src/app.ts`
  - Register `/api/public/*` routes before `/api/:pubKey*` auth middleware and business routes.
- Modify: `packages/server/src/routes/soul.ts`
  - Clear copied profile/avatar rows after soul copy succeeds.
- Create: `packages/server/test/routes/profile.test.ts`
  - Cover owner/public profile and avatar route behavior, auth boundaries, bootstrap, validation, and avatar response semantics.
- Modify: `packages/server/test/routes/soul.test.ts`
  - Cover soul copy clearing profile/avatar data in the copied sqlite file.
- Modify: `packages/web/src/lib/api-client.ts`
  - Add signed binary upload support and owner/public profile helpers if useful.
- Modify: `packages/web/test/lib/api-client.test.ts`
  - Cover binary signing and `Content-Type: image/webp` upload behavior.
- Create: `packages/web/src/lib/profile.ts`
  - Single source of truth for profile payload types, empty-state defaults, fallback display name logic, and avatar URL versioning.
- Create: `packages/web/src/lib/avatar-editor.ts`
  - Canvas-based crop/export/compress helpers for square `webp` avatar generation.
- Create: `packages/web/test/lib/avatar-editor.test.ts`
  - Cover crop/export logic, mime rejection, and oversize compression fallback.
- Create: `packages/web/src/components/profile/AvatarCropDialog.tsx`
  - UI for image selection, square crop, zoom, and confirm/cancel.
- Create: `packages/web/test/components/profile/AvatarCropDialog.test.tsx`
  - Cover crop dialog states and confirm flow.
- Modify: `packages/web/src/pages/SettingsPage.tsx`
  - Add public profile card, owner bootstrap load, text save flow, avatar upload/delete flow, and preview refresh.
- Modify: `packages/web/test/pages/SettingsPage.test.tsx`
  - Cover profile field loading, save, avatar preview state, and upload/delete entry points.
- Modify: `packages/web/src/pages/ProfilePage.tsx`
  - Replace public key-only layout with public profile card backed by public API reads.
- Create: `packages/web/test/pages/ProfilePage.test.tsx`
  - Cover profile render, fallback nickname, fallback avatar, and message CTA.
- Modify: `packages/web/public/locales/zh/translation.json`
  - Add user-facing copy for public profile editing, upload, crop, save, delete, and validation.
- Modify: `packages/web/public/locales/en/translation.json`
  - Add matching English translations.

## Chunk 1: Server Profile Foundation

### Task 1: Add failing schema bootstrap test coverage

**Files:**

- Create: `packages/server/test/routes/profile.test.ts`
- Check: `packages/server/src/db/migrate.ts`
- Check: `packages/server/src/app.ts`

- [ ] **Step 1: Write failing tests for owner/public profile empty-state reads**

```ts
it("GET /api/:pubKey/profile returns editable empty state for a new owner", async () => {
  const res = await app.request(`/api/${PUB_KEY}/profile`, { headers: ownerHeaders });
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toMatchObject({
    data: { displayName: "", bio: "", hasAvatar: false, avatarVersion: null, updatedAt: null },
  });
});

it("GET /api/public/:pubKey/profile returns 404 for missing soul", async () => {
  const res = await app.request(`/api/public/${PUB_KEY}/profile`);
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run the new route test file to verify failure**

Run: `npm test -- packages/server/test/routes/profile.test.ts`
Expected: FAIL because profile routes/schema do not exist yet.

- [ ] **Step 3: Add failing tests for public route auth bypass and avatar 404**

```ts
it("GET /api/public/:pubKey/profile is accessible without auth headers for an existing soul", async () => {
  connMgr.getConnection(PUB_KEY, { create: true });
  const res = await app.request(`/api/public/${PUB_KEY}/profile`);
  expect(res.status).toBe(200);
});

it("GET /api/public/:pubKey/profile/avatar returns 404 when avatar missing", async () => {
  const res = await app.request(`/api/public/${PUB_KEY}/profile/avatar`);
  expect(res.status).toBe(404);
});

it("GET /api/public/:pubKey/profile/avatar returns 404 when soul is missing", async () => {
  const res = await app.request(`/api/public/${PUB_KEY}/profile/avatar`);
  expect(res.status).toBe(404);
});

it("GET /api/public/:pubKey/profile/avatar returns 200 with image/webp and no auth headers when avatar exists", async () => {
  await seedAvatar(PUB_KEY);
  const res = await app.request(`/api/public/${PUB_KEY}/profile/avatar`);
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("image/webp");
});

it("public profile/avatar routes reject invalid pubKey with 422", async () => {
  const profileRes = await app.request(`/api/public/not-base58/profile`);
  const avatarRes = await app.request(`/api/public/not-base58/profile/avatar`);
  expect(profileRes.status).toBe(422);
  expect(avatarRes.status).toBe(422);
});
```

- [ ] **Step 4: Re-run the route test file and confirm failure reason is missing routes/behavior**

Run: `npm test -- packages/server/test/routes/profile.test.ts`
Expected: FAIL with 404/500 mismatches because profile endpoints are not implemented.

### Task 2: Add schema and route implementation

**Files:**

- Modify: `packages/server/src/db/migrate.ts`
- Modify: `packages/server/src/db/schema.ts`
- Create: `packages/server/src/routes/profile.ts`
- Create: `packages/server/src/routes/public-profile.ts`
- Modify: `packages/server/src/app.ts`

- [ ] **Step 1: Add `public_profile` and `public_profile_avatar` schema definitions**

```ts
export const publicProfile = sqliteTable("public_profile", {
  id: text("id").primaryKey(),
  displayName: text("display_name"),
  bio: text("bio"),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

export const publicProfileAvatar = sqliteTable("public_profile_avatar", {
  id: text("id").primaryKey(),
  blob: blob("blob", { mode: "buffer" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});
```

- [ ] **Step 2: Add idempotent table creation to database bootstrap**

```sql
CREATE TABLE IF NOT EXISTS public_profile (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  bio TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS public_profile_avatar (
  id TEXT PRIMARY KEY,
  blob BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- [ ] **Step 3: Implement owner profile routes with bootstrap empty-state reads**

```ts
profileRoutes.get("/:pubKey/profile", (c) => {
  if (c.get("role") !== "owner") return c.json({ error: "FORBIDDEN" }, 403);
  return c.json({
    data: readProfileSummary(c.get("connMgr").getConnection(c.req.param("pubKey"))),
  });
});
```

- [ ] **Step 4: Add failing tests for owner text update and validation rules**

```ts
it("PUT /api/:pubKey/profile trims displayName and persists bio", async () => {
  const res = await app.request(`/api/${PUB_KEY}/profile`, {
    method: "PUT",
    headers: ownerJsonHeaders,
    body: JSON.stringify({ displayName: "  Z  ", bio: "hello" }),
  });
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toMatchObject({ data: { displayName: "Z", bio: "hello" } });
});

it("PUT /api/:pubKey/profile rejects invalid text payloads with 422", async () => {
  const res = await app.request(`/api/${PUB_KEY}/profile`, {
    method: "PUT",
    headers: ownerJsonHeaders,
    body: JSON.stringify({ displayName: "x".repeat(41), bio: "" }),
  });
  expect(res.status).toBe(422);
});

it("visitor cannot update owner profile", async () => {
  const res = await visitorApp.request(`/api/${PUB_KEY}/profile`, {
    method: "PUT",
    headers: visitorJsonHeaders,
    body: JSON.stringify({ displayName: "Z", bio: "hello" }),
  });
  expect(res.status).toBe(403);
});
```

- [ ] **Step 5: Add failing tests for avatar upload, validation, and delete behavior**

```ts
it("PUT /api/:pubKey/profile/avatar stores image/webp and exposes avatarVersion", async () => {
  const res = await app.request(`/api/${PUB_KEY}/profile/avatar`, {
    method: "PUT",
    headers: { ...ownerHeaders, "Content-Type": "image/webp" },
    body: WEBP_BYTES,
  });
  expect(res.status).toBe(204);
  await expect(readOwnerProfile(PUB_KEY)).resolves.toMatchObject({
    hasAvatar: true,
    avatarVersion: expect.any(Number),
  });
});

it("PUT /api/:pubKey/profile/avatar rejects non-webp uploads with 422", async () => {
  const res = await app.request(`/api/${PUB_KEY}/profile/avatar`, {
    method: "PUT",
    headers: { ...ownerHeaders, "Content-Type": "image/png" },
    body: PNG_BYTES,
  });
  expect(res.status).toBe(422);
});

it("PUT /api/:pubKey/profile/avatar rejects oversized uploads with 422", async () => {
  const res = await app.request(`/api/${PUB_KEY}/profile/avatar`, {
    method: "PUT",
    headers: { ...ownerHeaders, "Content-Type": "image/webp" },
    body: new Uint8Array(2 * 1024 * 1024 + 1),
  });
  expect(res.status).toBe(422);
});

it("visitor cannot upload or delete owner avatar", async () => {
  const uploadRes = await visitorApp.request(`/api/${PUB_KEY}/profile/avatar`, {
    method: "PUT",
    headers: { ...visitorHeaders, "Content-Type": "image/webp" },
    body: WEBP_BYTES,
  });
  const deleteRes = await visitorApp.request(`/api/${PUB_KEY}/profile/avatar`, {
    method: "DELETE",
    headers: visitorHeaders,
  });
  expect(uploadRes.status).toBe(403);
  expect(deleteRes.status).toBe(403);
});

it("DELETE /api/:pubKey/profile/avatar removes the avatar row", async () => {
  await seedAvatar(PUB_KEY);
  const res = await app.request(`/api/${PUB_KEY}/profile/avatar`, {
    method: "DELETE",
    headers: ownerHeaders,
  });
  expect(res.status).toBe(204);
  await expect(readOwnerProfile(PUB_KEY)).resolves.toMatchObject({
    hasAvatar: false,
    avatarVersion: null,
  });
});

it("signed avatar upload succeeds through auth middleware with raw body-byte signing", async () => {
  const signedReq = await buildSignedBinaryRequest({
    method: "PUT",
    path: `/api/${PUB_KEY}/profile/avatar?cacheBust=1`,
    body: WEBP_BYTES,
    contentType: "image/webp",
    signer: ownerKeyStore,
  });
  const res = await app.request(signedReq.path, signedReq.init);
  expect(res.status).toBe(204);
});
```

- [ ] **Step 6: Re-run the route test file and confirm the write-path tests fail for missing behavior**

Run: `npm test -- packages/server/test/routes/profile.test.ts`
Expected: FAIL because write routes/validation/avatar storage are not implemented yet.

- [ ] **Step 7: Implement owner text upsert, avatar upload, and avatar delete**

```ts
const PROFILE_ID = "singleton";
profileRoutes.put("/:pubKey/profile", zValidator("json", profileSchema), (c) => {
  /* trim displayName; bio 0-280; 422 on invalid; updatedAt=Date.now() */
});
profileRoutes.put("/:pubKey/profile/avatar", async (c) => {
  /* require role === owner; require image/webp; size <= 2MB; upsert blob; updatedAt=Date.now(); return 204 */
});
profileRoutes.delete("/:pubKey/profile/avatar", (c) => {
  /* require role === owner; delete singleton row */
});
```

- [ ] **Step 8: Implement summary derivation rules used by both owner/public reads**

```ts
function readProfileSummary(conn: DbConnection) {
  const profile = /* select singleton from public_profile */;
  const avatar = /* select singleton from public_profile_avatar */;
  return {
    displayName: profile?.displayName ?? "",
    bio: profile?.bio ?? "",
    hasAvatar: Boolean(avatar),
    avatarVersion: avatar?.updatedAt ?? null,
    updatedAt: profile?.updatedAt ?? null,
  };
}
```

- [ ] **Step 9: Implement public read routes with explicit `pubKey` validation**

```ts
publicProfileRoutes.get("/public/:pubKey/profile", (c) => {
  validatePubKeyOrThrow422(c.req.param("pubKey"));
  if (!connMgr.soulExists(pubKey)) return c.json({ error: "SOUL_NOT_FOUND" }, 404);
  return c.json({ data: readProfileSummary(connMgr.getConnection(pubKey)) });
});
```

- [ ] **Step 10: Ensure avatar reads always respond with `Content-Type: image/webp`**

```ts
return new Response(avatar.blob, { status: 200, headers: { "Content-Type": "image/webp" } });
```

- [ ] **Step 11: Register public routes before auth middleware in `createApp()`**

```ts
app.route("/api", publicProfileRoutes);
app.use("/api/:pubKey/*", authMiddleware());
app.use("/api/:pubKey", authMiddleware());
```

- [ ] **Step 12: Run the profile route test file and verify it passes**

Run: `npm test -- packages/server/test/routes/profile.test.ts`
Expected: PASS.

### Task 3: Cover soul copy semantics and regressions

**Files:**

- Modify: `packages/server/test/routes/soul.test.ts`
- Modify: `packages/server/src/routes/soul.ts`

- [ ] **Step 1: Add a failing test proving copied souls must not inherit public identity**

```ts
it("POST /api/:pubKey/copy clears copied public profile and avatar rows", async () => {
  await seedProfileAndAvatar(PUB_KEY);
  const res = await app.request(`/api/${PUB_KEY}/copy`, {
    method: "POST",
    headers: ownerJsonHeaders,
    body: JSON.stringify({ targetPubKey: TARGET_PUB_KEY }),
  });
  expect(res.status).toBe(201);
  await expect(readPublicProfile(TARGET_PUB_KEY)).resolves.toMatchObject({
    hasAvatar: false,
    displayName: "",
  });
});
```

- [ ] **Step 2: Run the route test file to verify failure**

Run: `npm test -- packages/server/test/routes/soul.test.ts`
Expected: FAIL because copied sqlite still contains source profile rows.

- [ ] **Step 3: Clear `public_profile` and `public_profile_avatar` after `copyFileSync()`**

```ts
const targetConn = connMgr.getConnection(targetPubKey, { create: false });
targetConn.raw.exec(`DELETE FROM public_profile; DELETE FROM public_profile_avatar;`);
```

- [ ] **Step 4: Re-run the route test file and verify it passes**

Run: `npm test -- packages/server/test/routes/soul.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the broader server route suite for regression coverage**

Run: `npm test -- packages/server/test/routes/*.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit server foundation changes**

```bash
git add packages/server/src/db/migrate.ts packages/server/src/db/schema.ts packages/server/src/routes/profile.ts packages/server/src/routes/public-profile.ts packages/server/src/routes/soul.ts packages/server/src/app.ts packages/server/test/routes/profile.test.ts packages/server/test/routes/soul.test.ts
git commit -m "feat(server): add public profile routes and storage"
```

## Chunk 2: Web Client, Avatar Crop, and Public UI

### Task 4: Extend the web API client for binary avatar upload

**Files:**

- Modify: `packages/web/src/lib/api-client.ts`
- Modify: `packages/web/test/lib/api-client.test.ts`
- Create: `packages/web/src/lib/profile.ts`

- [ ] **Step 1: Write a failing test for signed binary PUT requests**

```ts
it("sends signed binary PUT requests with raw body bytes", async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" });
  mockFetch.mockResolvedValue({ ok: true, status: 204, json: vi.fn() });

  await client.putBinary("/api/abc/profile/avatar", blob, "image/webp");

  const [, init] = mockFetch.mock.calls[0];
  expect(init.headers["Content-Type"]).toBe("image/webp");
  expect(init.headers["X-Public-Key"]).toBe("mockPubKey123");
  expect(init.headers["X-Timestamp"]).toBeDefined();
  expect(init.headers["X-Signature"]).toBe("mockSignature456");
  expect(init.body).toBe(blob);
});

it("signs binary uploads with pathname and raw body bytes", async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" });
  mockFetch.mockResolvedValue({ ok: true, status: 204, json: vi.fn() });

  await client.putBinary("/api/abc/profile/avatar?foo=bar", blob, "image/webp");

  const signArg = mockKeyStore.sign.mock.calls[0][0];
  const signStr = new TextDecoder().decode(signArg);
  expect(signStr).toContain("/api/abc/profile/avatar");
  expect(signStr).not.toContain("foo=bar");
});
```

- [ ] **Step 2: Run the API client test file and verify failure**

Run: `npm test -- packages/web/test/lib/api-client.test.ts`
Expected: FAIL because `putBinary()` does not exist.

- [ ] **Step 3: Add `putBinary()` and shared profile helpers**

```ts
async putBinary(path: string, body: Blob, contentType: string): Promise<void> {
  const bytes = new Uint8Array(await body.arrayBuffer());
  return this.requestBinary("PUT", path, bytes, body, contentType);
}

export const emptyPublicProfile = {
  displayName: "",
  bio: "",
  hasAvatar: false,
  avatarVersion: null,
  updatedAt: null,
};

export function buildAvatarUrl(pubKey: string, version: number | null): string | null {
  return version ? `/api/public/${pubKey}/profile/avatar?v=${version}` : null;
}

export function getFallbackDisplayName(pubKey: string, displayName: string): string {
  return displayName.trim() || `${pubKey.slice(0, 6)}...${pubKey.slice(-4)}`;
}
```

Binary upload contract:

```ts
// requestBinary() must sign `method + pathname + timestamp + raw body bytes`
// using the Uint8Array read from Blob.arrayBuffer(), while fetch should send
// the original Blob as `init.body` so the browser sets request streaming/body
// semantics naturally. Tests and implementation must follow this exact contract.
```

- [ ] **Step 4: Re-run the API client test file and verify it passes**

Run: `npm test -- packages/web/test/lib/api-client.test.ts`
Expected: PASS.

### Task 5: Build and test the avatar crop/export helper

**Files:**

- Create: `packages/web/src/lib/avatar-editor.ts`
- Create: `packages/web/test/lib/avatar-editor.test.ts`

- [ ] **Step 1: Write failing tests for crop/export behavior**

```ts
it("exports a square webp avatar from crop settings", async () => {
  const result = await exportCroppedAvatar({ image, crop, zoom, size: 512 });
  expect(result.type).toBe("image/webp");
});

it("rejects gif inputs before crop export", async () => {
  await expect(
    validateAvatarFile(new File(["gif"], "x.gif", { type: "image/gif" })),
  ).rejects.toThrow(/gif/i);
});

it("reduces quality or dimensions until the avatar fits the upload limit", async () => {
  const result = await exportCroppedAvatar({
    image,
    crop,
    zoom,
    size: 1024,
    maxBytes: 2 * 1024 * 1024,
  });
  expect(result.size).toBeLessThanOrEqual(2 * 1024 * 1024);
});

it("fails deterministically when the avatar cannot be reduced under the limit", async () => {
  await expect(
    exportCroppedAvatar({ image, crop, zoom, size: 1024, maxBytes: 64 }),
  ).rejects.toThrow(/size/i);
});
```

- [ ] **Step 2: Run the avatar helper tests and verify failure**

Run: `npm test -- packages/web/test/lib/avatar-editor.test.ts`
Expected: FAIL because helper module does not exist.

- [ ] **Step 3: Implement file validation, canvas export, and oversize compression loop**

```ts
export async function exportCroppedAvatar(input: ExportInput): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = input.size;
  canvas.height = input.size;
  // drawImage with crop rect, then iteratively toBlob("image/webp", quality)
}
```

- [ ] **Step 4: Re-run the avatar helper tests and verify they pass**

Run: `npm test -- packages/web/test/lib/avatar-editor.test.ts`
Expected: PASS.

### Task 6: Add the crop dialog UI and final blob contract

**Files:**

- Create: `packages/web/src/components/profile/AvatarCropDialog.tsx`
- Create: `packages/web/test/components/profile/AvatarCropDialog.test.tsx`

- [ ] **Step 1: Write failing component tests for crop dialog states**

```tsx
it("shows selected file preview and confirm button", async () => {
  render(<AvatarCropDialog open file={file} onConfirm={onConfirm} />);
  expect(screen.getByRole("button", { name: /confirm/i })).toBeInTheDocument();
});

it("returns the final webp blob through its confirm callback contract", async () => {
  render(<AvatarCropDialog open file={file} onConfirm={onConfirm} />);
  await user.click(screen.getByRole("button", { name: /confirm/i }));
  expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ type: "image/webp" }));
});
```

- [ ] **Step 2: Run the crop dialog tests and verify failure**

Run: `npm test -- packages/web/test/components/profile/AvatarCropDialog.test.tsx`
Expected: FAIL because component does not exist.

- [ ] **Step 3: Implement a minimal square crop dialog with drag/zoom controls**

```tsx
export function AvatarCropDialog({ open, file, onConfirm, onCancel }: Props) {
  // preview image, square crop frame, zoom range input, confirm/cancel buttons
}
```

Callback contract:

```ts
type Props = {
  open: boolean;
  file: File | null;
  onConfirm: (blob: Blob) => void;
  onCancel: () => void;
};
```

Requirement:

```ts
// Task 6 is responsible for completing the full dialog contract:
// select image -> adjust crop/zoom -> confirm -> export final webp blob -> onConfirm(blob)
```

- [ ] **Step 4: Re-run the crop dialog tests and verify they pass**

Run: `npm test -- packages/web/test/components/profile/AvatarCropDialog.test.tsx`
Expected: PASS.

### Task 7: Upgrade Settings page to edit and upload public profile

**Files:**

- Modify: `packages/web/src/pages/SettingsPage.tsx`
- Modify: `packages/web/test/pages/SettingsPage.test.tsx`
- Modify: `packages/web/public/locales/zh/translation.json`
- Modify: `packages/web/public/locales/en/translation.json`

- [ ] **Step 1: Write failing page tests for owner profile bootstrap and save flow**

```tsx
it("loads owner profile data into the public profile form", async () => {
  mockProfileFetch({ displayName: "Z", bio: "hello", hasAvatar: true, avatarVersion: 1 });
  renderWithProviders(<SettingsPage />);
  expect(await screen.findByDisplayValue("Z")).toBeInTheDocument();
});

it("uploads a cropped avatar and refreshes preview version", async () => {
  // select file -> confirm crop -> expect putBinary + re-fetch profile
});

it("saves edited displayName and bio through PUT /api/:pubKey/profile", async () => {
  // edit fields -> click save -> expect JSON PUT and success state refresh
});

it("rejects gif selection before crop/upload", async () => {
  // select image/gif -> expect validation message and no putBinary call
});

it("shows delete avatar CTA, deletes avatar, and refreshes preview version", async () => {
  // existing avatar -> click delete -> expect DELETE + owner profile re-fetch -> hasAvatar false + avatarVersion null
});
```

- [ ] **Step 2: Run the settings page tests and verify failure**

Run: `npm test -- packages/web/test/pages/SettingsPage.test.tsx`
Expected: FAIL because public profile UI and API flow do not exist.

- [ ] **Step 3: Implement public profile form state, save action, avatar upload/delete flow, and translated copy**

```tsx
const [profile, setProfile] = useState(emptyPublicProfile);
useEffect(() => {
  auth.apiClient.get(auth.apiClient.ownerPath("/profile"));
}, []);
```

- [ ] **Step 4: Re-run the settings page tests and verify they pass**

Run: `npm test -- packages/web/test/pages/SettingsPage.test.tsx`
Expected: PASS.

### Task 8: Upgrade the public profile page and finish end-to-end web coverage

**Files:**

- Modify: `packages/web/src/pages/ProfilePage.tsx`
- Create: `packages/web/test/pages/ProfilePage.test.tsx`
- Check: `packages/web/src/pages/SharePage.tsx`

- [ ] **Step 1: Write failing tests for public profile rendering and fallbacks**

```tsx
it("renders public nickname and bio from the public profile API", async () => {
  renderWithProviders(<ProfilePage />, { route: "/profile/abc" });
  expect(await screen.findByText("Z")).toBeInTheDocument();
  expect(screen.getByText("hello")).toBeInTheDocument();
});

it("falls back to truncated pubkey and ChatAvatar when profile is empty", async () => {
  // assert fallback render path
});

it("keeps the truncated public key visible as supporting identity text", async () => {
  // assert truncated pubkey is still rendered below the display name area
});
```

- [ ] **Step 2: Run the profile page tests and verify failure**

Run: `npm test -- packages/web/test/pages/ProfilePage.test.tsx`
Expected: FAIL because page still renders the old public-key-only UI.

- [ ] **Step 3: Implement public profile loading, avatar version URL, fallback rendering, and CTA preservation**

- [ ] **Step 3: Implement public profile loading, avatar version URL, fallback rendering, public-key supporting text, and CTA preservation**

```tsx
const { pubKey } = useParams();
useEffect(() => {
  fetch(`/api/public/${pubKey}/profile`);
}, [pubKey]);

const avatarUrl = buildAvatarUrl(pubKey, profile.avatarVersion);
const displayName = getFallbackDisplayName(pubKey, profile.displayName);
```

- [ ] **Step 4: Re-run the profile page tests and verify they pass**

Run: `npm test -- packages/web/test/pages/ProfilePage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the full web test suite for regression coverage**

Run: `npm test -- packages/web/test/**/*.test.ts*`
Expected: PASS.

- [ ] **Step 6: Run the full repo test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit the web/profile UI changes**

```bash
git add packages/web/src/lib/api-client.ts packages/web/test/lib/api-client.test.ts packages/web/src/lib/profile.ts packages/web/src/lib/avatar-editor.ts packages/web/test/lib/avatar-editor.test.ts packages/web/src/components/profile/AvatarCropDialog.tsx packages/web/test/components/profile/AvatarCropDialog.test.tsx packages/web/src/pages/SettingsPage.tsx packages/web/test/pages/SettingsPage.test.tsx packages/web/src/pages/ProfilePage.tsx packages/web/test/pages/ProfilePage.test.tsx packages/web/public/locales/zh/translation.json packages/web/public/locales/en/translation.json
git commit -m "feat(web): add editable public profile experience"
```
