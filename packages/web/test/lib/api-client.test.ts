import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { ApiClient, type ApiClientConfig } from "../../src/lib/api-client";
import { buildStringToSign } from "../../src/lib/signing";
import {
  buildAvatarUrl,
  buildPublicProfileUrl,
  emptyPublicProfile,
  getFallbackDisplayName,
} from "../../src/lib/profile";

// Mock KeyStore
function createMockKeyStore() {
  return {
    getPublicKey: () => "mockPubKey123",
    sign: vi.fn().mockResolvedValue("mockSignature456"),
  };
}

describe("ApiClient", () => {
  let client: ApiClient;
  let mockKeyStore: ReturnType<typeof createMockKeyStore>;
  let mockFetch: Mock;

  beforeEach(() => {
    mockKeyStore = createMockKeyStore();
    client = new ApiClient({
      baseUrl: "https://api.test.com",
      keyStore: mockKeyStore,
    } satisfies ApiClientConfig);
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  it("should send GET with auth headers", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ data: [] }) };
    mockFetch.mockResolvedValue(mockResponse);

    await client.get("/api/abc/anchors");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.test.com/api/abc/anchors");
    expect(init.headers["X-Public-Key"]).toBe("mockPubKey123");
    expect(init.headers["X-Timestamp"]).toBeDefined();
    expect(init.headers["X-Signature"]).toBe("mockSignature456");
  });

  it("should send POST with body and Content-Type", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ data: {} }) };
    mockFetch.mockResolvedValue(mockResponse);

    await client.post("/api/abc/reasoning/message", { content: "hello" });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe('{"content":"hello"}');
  });

  it("should sign with pathname only (no query string)", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ data: {} }) };
    mockFetch.mockResolvedValue(mockResponse);

    await client.get("/api/abc/anchors?limit=50");

    expect(mockKeyStore.sign).toHaveBeenCalledOnce();
    const signArg = mockKeyStore.sign.mock.calls[0][0];
    const signStr = new TextDecoder().decode(signArg);
    expect(signStr).toContain("/api/abc/anchors");
    expect(signStr).not.toContain("limit=50");
  });

  it("should throw on non-ok response", async () => {
    const mockResponse = {
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: "FORBIDDEN", message: "Not allowed" }),
    };
    mockFetch.mockResolvedValue(mockResponse);

    await expect(client.get("/api/abc/anchors")).rejects.toThrow();
  });

  it("should provide ownerPath helper", () => {
    const path = client.ownerPath("/anchors");
    expect(path).toBe("/api/mockPubKey123/anchors");
  });

  it("sends signed binary PUT requests with raw body bytes", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" });
    mockFetch.mockResolvedValue({ ok: true, status: 204, json: vi.fn() });

    await client.putBinary("/api/abc/profile/avatar", blob, "image/webp");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe("PUT");
    expect(init.headers["Content-Type"]).toBe("image/webp");
    expect(init.headers["X-Public-Key"]).toBe("mockPubKey123");
    expect(init.headers["X-Timestamp"]).toBeDefined();
    expect(init.headers["X-Signature"]).toBe("mockSignature456");
    expect(init.body).toBe(blob);
  });

  it("signs binary uploads with pathname and raw body bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const blob = new Blob([bytes], { type: "image/webp" });
    mockFetch.mockResolvedValue({ ok: true, status: 204, json: vi.fn() });

    await client.putBinary("/api/abc/profile/avatar?foo=bar", blob, "image/webp");

    const signArg = mockKeyStore.sign.mock.calls[0][0] as Uint8Array;
    const signStr = new TextDecoder().decode(signArg);
    const [, init] = mockFetch.mock.calls[0];
    const expected = await buildStringToSign(
      "PUT",
      "/api/abc/profile/avatar",
      init.headers["X-Timestamp"],
      bytes,
    );
    expect(signStr).toContain("/api/abc/profile/avatar");
    expect(signStr).not.toContain("foo=bar");
    expect(signStr).toBe(expected);
  });
});

describe("profile helpers", () => {
  it("provides an empty public profile default", () => {
    expect(emptyPublicProfile).toEqual({
      displayName: "",
      bio: "",
      hasAvatar: false,
      avatarVersion: null,
      updatedAt: null,
    });
  });

  it("builds avatar urls with version query", () => {
    expect(buildAvatarUrl("pubKey123", 123)).toBe(
      `${window.location.origin}/api/public/pubKey123/profile/avatar?v=123`,
    );
    expect(buildAvatarUrl("pubKey123", 0)).toBe(
      `${window.location.origin}/api/public/pubKey123/profile/avatar?v=0`,
    );
    expect(buildAvatarUrl("pubKey123", null)).toBeNull();
  });

  it("builds public profile urls with the configured base", () => {
    expect(buildPublicProfileUrl("pubKey123")).toBe(
      `${window.location.origin}/api/public/pubKey123/profile`,
    );
  });

  it("falls back to a shortened public key when display name is blank", () => {
    expect(getFallbackDisplayName("1234567890abcdef", "  ")).toBe("123456...cdef");
    expect(getFallbackDisplayName("1234567890abcdef", " Alice ")).toBe("Alice");
  });
});
