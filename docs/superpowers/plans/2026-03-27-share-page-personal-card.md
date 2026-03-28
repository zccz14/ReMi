# Share Page Personal Card Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `/share` from a plain QR utility screen into a personal-card-first share page with profile-driven copy, avatar-aware QR center imagery, and stable regression coverage.

**Architecture:** Keep the existing `/share` route and owner-profile bootstrap flow, but store the resolved owner profile payload in page state so the screen can render a personal card before the QR action area. Reuse existing profile helpers for fallback display name and avatar URL generation, prefer `QRCodeSVG`'s built-in `imageSettings` support for the center image, and expose deterministic `data-testid` hooks so unit tests can verify avatar/logo/pure-QR branches without depending on SVG internals.

**Tech Stack:** React 19, Vite, TypeScript, `qrcode.react`, React Testing Library, Vitest, Playwright, i18next.

---

## Chunk 1: Copy Contract + Unit-Test Contract

### Task 1: Update locale copy before writing visible-behavior tests

**Files:**

- Modify: `packages/web/public/locales/zh/translation.json`
- Modify: `packages/web/public/locales/en/translation.json`
- Reference: `docs/superpowers/specs/2026-03-27-share-page-personal-card-design.md`

- [ ] **Step 1: Add the final Chinese share strings**

```json
"share": {
  "title": "分享分身",
  "description": "来 ReMi 链接我",
  "subtitle": "先认识我的分身，再开始聊天",
  "copyLink": "复制链接",
  "copied": "链接已复制，发给朋友吧",
  "bootstrapping": "正在准备公开资料…",
  "bootstrapError": "公开资料准备失败，请稍后重试。"
}
```

- [ ] **Step 2: Add the matching English strings**

```json
"share": {
  "title": "Share Persona",
  "description": "Find me on ReMi",
  "subtitle": "Meet my persona first, then start the conversation",
  "copyLink": "Copy link",
  "copied": "Link copied. Send it to a friend.",
  "bootstrapping": "Preparing your public profile…",
  "bootstrapError": "Failed to prepare your public profile. Try again later."
}
```

- [ ] **Step 3: Run a narrow syntax check via the share page unit file**

Run: `npm test -- SharePage.test.tsx`
Expected: FAIL on old behavior assertions, not from malformed locale JSON.

- [ ] **Step 4: Optional checkpoint commit**

```bash
git add packages/web/public/locales/zh/translation.json packages/web/public/locales/en/translation.json
git commit -m "feat: refresh share page invite copy"
```

### Task 2: Lock in the new unit-test contract first

**Files:**

- Modify: `packages/web/test/pages/SharePage.test.tsx`
- Reference: `packages/web/src/lib/profile.ts`
- Reference: `packages/web/test/helpers/test-utils.tsx`

- [ ] **Step 1: Rewrite the QR mock so tests can inspect QR image settings**

```tsx
vi.mock("qrcode.react", () => ({
  QRCodeSVG: (props: any) => (
    <svg
      data-testid="share-qr-svg"
      data-value={props.value}
      data-image-src={props.imageSettings?.src ?? "none"}
      data-level={props.level}
    />
  ),
}));
```

- [ ] **Step 2: Add explicit fixtures/helpers that actually exist in the test file**

```tsx
import type { PublicProfile } from "../../src/lib/profile";

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

function createProfile(overrides?: Partial<PublicProfile>): PublicProfile {
  return {
    displayName: "Alice",
    bio: "Human, builder, and friendly ReMi contact.",
    hasAvatar: true,
    avatarVersion: 3,
    updatedAt: 123,
    ...overrides,
  };
}

function createApiClient(result: Promise<{ data: PublicProfile }> | { data: PublicProfile }) {
  return {
    get: vi.fn(() => Promise.resolve(result)),
    post: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
    streamPost: vi.fn(),
    ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}
```

- [ ] **Step 3: Replace the old tests with fully specified failing tests**

```tsx
it("renders the personal-card copy and resolved profile data after bootstrap", async () => {
  const { getByText, getByTestId } = renderWithProviders(<SharePage />, {
    authState: { apiClient: createApiClient({ data: createProfile() }) as any },
  });

  await waitFor(() => expect(getByText("来 ReMi 链接我")).toBeInTheDocument());
  expect(getByText("Alice")).toBeInTheDocument();
  expect(getByText("Human, builder, and friendly ReMi contact.")).toBeInTheDocument();
  expect(getByTestId("share-card")).toBeInTheDocument();
  expect(getByTestId("share-link")).toHaveTextContent(
    "http://localhost:3000/profile/mock-public-key",
  );
});

it("falls back to truncated public key and hides the bio when profile fields are empty", async () => {
  const { getByText, queryByTestId } = renderWithProviders(<SharePage />, {
    authState: {
      apiClient: createApiClient({
        data: createProfile({
          displayName: "   ",
          bio: "   ",
          hasAvatar: false,
          avatarVersion: null,
        }),
      }) as any,
    },
  });

  await waitFor(() => expect(getByText("mock-p...-key")).toBeInTheDocument());
  expect(queryByTestId("share-card-bio")).toBeNull();
});

it("uses avatar image settings for the QR code when avatar metadata exists", async () => {
  const { getByTestId } = renderWithProviders(<SharePage />, {
    authState: { apiClient: createApiClient({ data: createProfile() }) as any },
  });

  await waitFor(() => expect(getByTestId("share-qr-svg")).toBeInTheDocument());
  expect(getByTestId("share-qr-svg")).toHaveAttribute(
    "data-image-src",
    expect.stringContaining("/api/public/mock-public-key/profile/avatar?v=3"),
  );
  expect(getByTestId("share-qr-svg")).toHaveAttribute("data-level", "H");
  expect(getByTestId("share-qr-wrapper")).toHaveAttribute("data-center-image-kind", "avatar");
});

it("falls back to the app logo when no avatar metadata exists", async () => {
  const { getByTestId } = renderWithProviders(<SharePage />, {
    authState: {
      apiClient: createApiClient({
        data: createProfile({ hasAvatar: false, avatarVersion: null }),
      }) as any,
    },
  });

  await waitFor(() => expect(getByTestId("share-qr-svg")).toBeInTheDocument());
  expect(getByTestId("share-qr-svg")).toHaveAttribute("data-image-src", "/icons/icon-192.png");
  expect(getByTestId("share-qr-wrapper")).toHaveAttribute("data-center-image-kind", "logo");
});

it("falls back to a pure qr when center images are forced off", async () => {
  const { getByTestId } = renderWithProviders(<SharePage forceQrImageFallback="none" />, {
    authState: {
      apiClient: createApiClient({
        data: createProfile({ hasAvatar: false, avatarVersion: null }),
      }) as any,
    },
  });

  await waitFor(() => expect(getByTestId("share-qr-svg")).toBeInTheDocument());
  expect(getByTestId("share-qr-svg")).toHaveAttribute("data-image-src", "none");
  expect(getByTestId("share-qr-wrapper")).toHaveAttribute("data-center-image-kind", "none");
});

it("falls back from avatar to logo when the avatar probe fails", async () => {
  mockImageProbeSequence([{ ok: false }, { ok: true }]);

  const { getByTestId } = renderWithProviders(<SharePage />, {
    authState: { apiClient: createApiClient({ data: createProfile() }) as any },
  });

  await waitFor(() => {
    expect(getByTestId("share-qr-wrapper")).toHaveAttribute("data-center-image-kind", "logo");
  });
  expect(getByTestId("share-qr-svg")).toHaveAttribute("data-image-src", "/icons/icon-192.png");
});

it("falls back from logo to pure qr when both probes fail", async () => {
  mockImageProbeSequence([{ ok: false }, { ok: false }]);

  const { getByTestId } = renderWithProviders(<SharePage />, {
    authState: { apiClient: createApiClient({ data: createProfile() }) as any },
  });

  await waitFor(() => {
    expect(getByTestId("share-qr-wrapper")).toHaveAttribute("data-center-image-kind", "none");
  });
  expect(getByTestId("share-qr-svg")).toHaveAttribute("data-image-src", "none");
});

it("keeps the card shell visible while loading and after bootstrap failure", async () => {
  const deferred = createDeferred<{ data: PublicProfile }>();
  const loading = renderWithProviders(<SharePage />, {
    authState: { apiClient: createApiClient(deferred.promise) as any },
  });

  expect(loading.getByTestId("share-card")).toBeInTheDocument();
  expect(loading.getByTestId("share-loading")).toBeInTheDocument();
  expect(loading.queryByTestId("share-qr-wrapper")).toBeNull();
  expect(loading.queryByTestId("share-link")).toBeNull();
  expect(loading.getByRole("button", { name: "复制链接" })).toBeDisabled();

  const failed = renderWithProviders(<SharePage />, {
    authState: {
      apiClient: {
        ...createApiClient({ data: createProfile() }),
        get: vi.fn().mockRejectedValue(new Error("bootstrap failed")),
      } as any,
    },
  });

  await waitFor(() => expect(failed.getByTestId("share-error")).toBeInTheDocument());
  expect(failed.getByTestId("share-card")).toBeInTheDocument();
  expect(failed.queryByTestId("share-qr-wrapper")).toBeNull();
  expect(failed.queryByTestId("share-link")).toBeNull();
  expect(failed.getByRole("button", { name: "复制链接" })).toBeDisabled();
});

it("copies the share link and shows the refreshed success toast", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });

  const { getByRole } = renderWithProviders(<SharePage />, {
    authState: { apiClient: createApiClient({ data: createProfile() }) as any },
  });

  await waitFor(() => expect(getByRole("button", { name: "复制链接" })).toBeEnabled());
  await userEvent.click(getByRole("button", { name: "复制链接" }));

  expect(writeText).toHaveBeenCalledWith("http://localhost:3000/profile/mock-public-key");
  expect(mockToastSuccess).toHaveBeenCalledWith("链接已复制，发给朋友吧");
});
```

Add the probe mock helper in the same test file so the runtime fallback path is verifiable:

```tsx
function mockImageProbeSequence(sequence: Array<{ ok: boolean }>) {
  let index = 0;

  vi.stubGlobal(
    "Image",
    class {
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;

      set src(_value: string) {
        const current = sequence[index++] ?? sequence[sequence.length - 1];
        queueMicrotask(() => {
          if (current?.ok) {
            this.onload?.();
          } else {
            this.onerror?.();
          }
        });
      }
    } as unknown as typeof Image,
  );
}
```

- [ ] **Step 4: Run the page test file to confirm the new expectations fail**

Run: `npm test -- SharePage.test.tsx`
Expected: FAIL with missing personal-card copy, missing test ids, and missing QR fallback behavior.

- [ ] **Step 5: Optional checkpoint commit**

```bash
git add packages/web/test/pages/SharePage.test.tsx
git commit -m "test: define share page personal card behavior"
```

## Chunk 2: Share Page Data + UI Refactor

### Task 3: Refactor `SharePage` to render profile-first content and QR center fallbacks

**Files:**

- Modify: `packages/web/src/pages/SharePage.tsx`
- Reference: `packages/web/src/lib/profile.ts`
- Reference: `packages/web/src/components/chat/ChatAvatar.tsx`
- Reference: `packages/web/public/icons/icon-192.png`
- Test: `packages/web/test/pages/SharePage.test.tsx`

- [ ] **Step 1: Introduce explicit owner-profile state and separate failure flags**

```tsx
const [profile, setProfile] = useState<PublicProfile>(emptyPublicProfile);
const [cardAvatarFailed, setCardAvatarFailed] = useState(false);
const [qrAvatarFailed, setQrAvatarFailed] = useState(false);
const [qrLogoFailed, setQrLogoFailed] = useState(false);

useEffect(() => {
  if (!publicKey) {
    setProfile(emptyPublicProfile);
    setBootstrapStatus("error");
    return;
  }

  setBootstrapStatus("loading");
  setProfile(emptyPublicProfile);
  setCardAvatarFailed(false);
  setQrAvatarFailed(false);
  setQrLogoFailed(false);

  void Promise.resolve(apiClient.get<{ data: PublicProfile }>(apiClient.ownerPath("/profile")))
    .then((response) => {
      if (!active) return;
      setProfile(response.data ?? emptyPublicProfile);
      setBootstrapStatus("ready");
    })
    .catch(() => {
      if (!active) return;
      setProfile(emptyPublicProfile);
      setBootstrapStatus("error");
    });
}, [apiClient, publicKey]);
```

- [ ] **Step 2: Derive display values with existing profile helpers**

```tsx
const resolvedDisplayName = publicKey
  ? getFallbackDisplayName(publicKey, profile.displayName)
  : t("share.title");
const bio = profile.bio.trim();
const avatarUrl =
  publicKey && profile.hasAvatar ? buildAvatarUrl(publicKey, profile.avatarVersion) : null;
const cardAvatarSrc = avatarUrl && !cardAvatarFailed ? avatarUrl : null;
const shareUrl = publicKey ? `${window.location.origin}/profile/${publicKey}` : "";

const qrCenterImageSrc = qrLogoFailed
  ? undefined
  : avatarUrl && !qrAvatarFailed
    ? avatarUrl
    : "/icons/icon-192.png";

const qrCenterImageKind = qrLogoFailed ? "none" : avatarUrl && !qrAvatarFailed ? "avatar" : "logo";

const qrImageSettings = qrCenterImageSrc
  ? { src: qrCenterImageSrc, height: 44, width: 44, excavate: true }
  : undefined;
```

Add one deterministic prop so unit tests can force the pure-QR branch without inventing a DOM image-probe subsystem:

```tsx
interface SharePageProps {
  forceQrImageFallback?: "auto" | "logo" | "none";
}

export function SharePage({ forceQrImageFallback = "auto" }: SharePageProps) {
  // route usage keeps the default "auto"
}

const qrCenterImageSrc =
  forceQrImageFallback === "none"
    ? undefined
    : forceQrImageFallback === "logo"
      ? "/icons/icon-192.png"
      : qrLogoFailed
        ? undefined
        : avatarUrl && !qrAvatarFailed
          ? avatarUrl
          : "/icons/icon-192.png";
```

- [ ] **Step 3: Rebuild the JSX as a personal-card layout with stable hooks**

```tsx
<div
  data-testid="share-card"
  className="w-full max-w-sm rounded-[28px] border bg-card p-5 shadow-sm"
>
  <div className="flex flex-col items-center gap-4 text-center">
    {cardAvatarSrc ? (
      <img
        data-testid="share-card-avatar-image"
        src={cardAvatarSrc}
        alt={resolvedDisplayName}
        onError={() => setCardAvatarFailed(true)}
        className="h-20 w-20 rounded-[24px] object-cover"
      />
    ) : (
      <div data-testid="share-card-avatar-fallback">
        <ChatAvatar pubKey={publicKey ?? "remi"} name={resolvedDisplayName} size="lg" />
      </div>
    )}

    <div className="space-y-2">
      <p className="text-xl font-semibold break-all">{resolvedDisplayName}</p>
      {bio ? <p data-testid="share-card-bio">{bio}</p> : null}
      <p data-testid="share-card-tagline">{t("share.description")}</p>
      <p className="text-sm text-muted-foreground">{t("share.subtitle")}</p>
    </div>
  </div>

  <div className="mt-5 min-h-[260px]">
    {bootstrapStatus === "loading" ? (
      <p data-testid="share-loading">{t("share.bootstrapping")}</p>
    ) : null}
    {bootstrapStatus === "error" ? (
      <p data-testid="share-error">{t("share.bootstrapError")}</p>
    ) : null}

    {bootstrapStatus === "ready" ? (
      <Card>
        <CardContent className="flex justify-center p-5">
          <div data-testid="share-qr-wrapper" data-center-image-kind={qrCenterImageKind}>
            <QRCodeSVG value={shareUrl} size={220} level="H" imageSettings={qrImageSettings} />
          </div>
        </CardContent>
      </Card>
    ) : (
      <div
        data-testid="share-card-placeholder"
        className="h-[220px] rounded-2xl border border-dashed"
      />
    )}
  </div>

  {bootstrapStatus === "ready" ? (
    <div
      data-testid="share-link"
      className="mt-4 text-xs font-mono text-muted-foreground break-all text-center"
    >
      {shareUrl}
    </div>
  ) : null}

  <Button
    className="mt-4 w-full"
    onClick={copyLink}
    disabled={bootstrapStatus !== "ready" || !shareUrl}
  >
    {t("share.copyLink")}
  </Button>
</div>
```

- [ ] **Step 4: Preserve the avatar -> logo -> pure-QR fallback path**

```tsx
useEffect(() => {
  setCardAvatarFailed(false);
  setQrAvatarFailed(false);
  setQrLogoFailed(false);
}, [avatarUrl]);

const handleCardAvatarError = () => setCardAvatarFailed(true);
const handleQrAvatarError = () => setQrAvatarFailed(true);
const handleQrLogoFailure = () => setQrLogoFailed(true);

useEffect(() => {
  if (!avatarUrl || forceQrImageFallback !== "auto") return;

  const probe = new Image();
  probe.onload = () => setQrAvatarFailed(false);
  probe.onerror = () => setQrAvatarFailed(true);
  probe.src = avatarUrl;

  return () => {
    probe.onload = null;
    probe.onerror = null;
  };
}, [avatarUrl, forceQrImageFallback]);

useEffect(() => {
  if (forceQrImageFallback !== "auto") return;
  if (!qrAvatarFailed && avatarUrl) return;

  const probe = new Image();
  probe.onload = () => setQrLogoFailed(false);
  probe.onerror = () => setQrLogoFailed(true);
  probe.src = "/icons/icon-192.png";

  return () => {
    probe.onload = null;
    probe.onerror = null;
  };
}, [avatarUrl, qrAvatarFailed, forceQrImageFallback]);
```

Concrete decision for this plan: use a minimal browser-native `Image()` probe for runtime fallback detection, keep the single explicit `forceQrImageFallback` prop for deterministic pure-QR unit coverage, and do not add any custom overlay implementation.

- [ ] **Step 5: Run the targeted unit tests until they pass**

Run: `npm test -- SharePage.test.tsx`
Expected: PASS with personal-card copy, fallback display name behavior, QR avatar/logo/none assertions, and copy-success toast coverage.

- [ ] **Step 6: Optional checkpoint commit**

```bash
git add packages/web/src/pages/SharePage.tsx packages/web/test/pages/SharePage.test.tsx packages/web/public/locales/zh/translation.json packages/web/public/locales/en/translation.json
git commit -m "feat: personalize the share page card"
```

## Chunk 3: Browser Regression Coverage + Final Verification

### Task 4: Tighten browser-level regression coverage and finish verification

**Files:**

- Modify: `e2e/settings.spec.ts`
- Reference: `packages/web/src/pages/SharePage.tsx`
- Reference: `packages/web/test/pages/SharePage.test.tsx`

- [ ] **Step 1: Replace the old share-page smoke assertions with stable, user-facing checks**

```ts
test("shows the personal share card, qr code, and public profile link", async ({ page }) => {
  await expect(page.getByText("来 ReMi 链接我")).toBeVisible();
  await expect(page.getByTestId("share-card")).toBeVisible();
  await expect(page.getByTestId("share-qr-wrapper")).toBeVisible();
  await expect(page.getByRole("button", { name: "复制链接" })).toBeEnabled();
  await expect(page.getByTestId("share-link")).toContainText("/profile/");
  await expect(page.getByTestId("share-loading")).toHaveCount(0);
  await expect(page.getByTestId("share-error")).toHaveCount(0);
});
```

- [ ] **Step 2: Run the targeted unit + e2e checks**

Run: `npm test -- SharePage.test.tsx && npm run test:e2e -- --grep "Share Page"`
Expected: PASS for both the focused unit suite and the share-page Playwright scenario.

- [ ] **Step 3: Run the broader verification expected before handoff**

Run: `npm test && npm run build:web`
Expected: PASS with no TypeScript, Vite, or Vitest regressions.

- [ ] **Step 4: Optional checkpoint commit**

```bash
git add e2e/settings.spec.ts packages/web/src/pages/SharePage.tsx packages/web/test/pages/SharePage.test.tsx packages/web/public/locales/zh/translation.json packages/web/public/locales/en/translation.json
git commit -m "test: cover personalized share page regressions"
```
