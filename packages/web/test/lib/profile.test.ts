import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPublicProfileCache,
  emptyPublicProfile,
  loadPublicProfileSummary,
  resolveProfileSummary,
} from "../../src/lib/profile";

const API_BASE = "https://api.example.test";
const PUB_KEY = "abcdef1234567890";

function okProfileResponse(
  overrides?: Partial<{
    displayName: string;
    bio: string;
    hasAvatar: boolean;
    avatarVersion: number | null;
    updatedAt: number | null;
  }>,
) {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({
      data: {
        displayName: "",
        bio: "",
        hasAvatar: false,
        avatarVersion: null,
        updatedAt: 1710000000000,
        ...overrides,
      },
    }),
  };
}

afterEach(() => {
  clearPublicProfileCache();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("profile resolver", () => {
  it("maps public profile data to a UI-ready identity shape", () => {
    vi.stubEnv("VITE_API_BASE", API_BASE);

    const result = resolveProfileSummary(PUB_KEY, {
      displayName: "Nova",
      bio: "  hello  ",
      hasAvatar: true,
      avatarVersion: 7,
      updatedAt: 1,
    });

    expect(result).toMatchObject({
      pubKey: PUB_KEY,
      displayName: "Nova",
      bio: "hello",
      avatarUrl: `${API_BASE}/api/public/${PUB_KEY}/profile/avatar?v=7`,
    });
  });

  it("falls back to truncated pubKey and no bio/avatar when profile is empty", () => {
    const result = resolveProfileSummary(PUB_KEY, emptyPublicProfile);

    expect(result.displayName).toBe("abcdef...7890");
    expect(result.bio).toBe("");
    expect(result.avatarUrl).toBeNull();
  });

  it("falls back to empty profile semantics when public profile fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));

    const result = await loadPublicProfileSummary(PUB_KEY);

    expect(result).toEqual({
      pubKey: PUB_KEY,
      displayName: "abcdef...7890",
      bio: "",
      avatarUrl: null,
    });
  });

  it("falls back to empty profile semantics when public profile returns non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    const result = await loadPublicProfileSummary(PUB_KEY);

    expect(result).toEqual({
      pubKey: PUB_KEY,
      displayName: "abcdef...7890",
      bio: "",
      avatarUrl: null,
    });
  });

  it("normalizes malformed ok payload data without crashing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: {
            displayName: "Nova",
            bio: null,
            hasAvatar: true,
            avatarVersion: "bad-version",
            updatedAt: "bad-updated-at",
          },
        }),
      }),
    );

    const result = await loadPublicProfileSummary(PUB_KEY);

    expect(result).toEqual({
      pubKey: PUB_KEY,
      displayName: "Nova",
      bio: "",
      avatarUrl: null,
    });
  });

  it("reuses the in-memory result for the same pubKey within one session", async () => {
    vi.stubEnv("VITE_API_BASE", API_BASE);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okProfileResponse({ displayName: "Nova" })));

    await loadPublicProfileSummary(PUB_KEY);
    await loadPublicProfileSummary(PUB_KEY);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("clears cached state between tests", async () => {
    vi.stubEnv("VITE_API_BASE", API_BASE);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okProfileResponse({ displayName: "Nova" })));

    await loadPublicProfileSummary(PUB_KEY);
    clearPublicProfileCache();
    await loadPublicProfileSummary(PUB_KEY);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries after a fallback response instead of caching the failure forever", async () => {
    vi.stubEnv("VITE_API_BASE", API_BASE);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce(okProfileResponse({ displayName: "Nova", bio: "hello" })),
    );

    const firstResult = await loadPublicProfileSummary(PUB_KEY);
    const secondResult = await loadPublicProfileSummary(PUB_KEY);

    expect(firstResult).toEqual({
      pubKey: PUB_KEY,
      displayName: "abcdef...7890",
      bio: "",
      avatarUrl: null,
    });
    expect(secondResult).toEqual({
      pubKey: PUB_KEY,
      displayName: "Nova",
      bio: "hello",
      avatarUrl: null,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries after a non-ok response instead of caching the fallback forever", async () => {
    vi.stubEnv("VITE_API_BASE", API_BASE);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValueOnce(okProfileResponse({ displayName: "Nova", bio: "hello" })),
    );

    const firstResult = await loadPublicProfileSummary(PUB_KEY);
    const secondResult = await loadPublicProfileSummary(PUB_KEY);

    expect(firstResult).toEqual({
      pubKey: PUB_KEY,
      displayName: "abcdef...7890",
      bio: "",
      avatarUrl: null,
    });
    expect(secondResult).toEqual({
      pubKey: PUB_KEY,
      displayName: "Nova",
      bio: "hello",
      avatarUrl: null,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
