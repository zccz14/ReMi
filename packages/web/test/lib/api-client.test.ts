import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { ApiClient, type ApiClientConfig } from "../../src/lib/api-client";

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
});
