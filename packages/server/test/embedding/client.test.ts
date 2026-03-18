import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmbeddingClient, createEmbeddingClient } from "../../src/embedding/client.js";

// Mock fetch for testing without real API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("EmbeddingClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("should send correct request to embedding API", async () => {
    const fakeEmbedding = Array.from({ length: 4 }, () => Math.random());
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ embedding: fakeEmbedding, index: 0 }],
      }),
    });

    const client = createEmbeddingClient({
      apiBase: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "test-model",
    });

    const result = await client.embed(["hello"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(fakeEmbedding);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/embeddings");
    expect(options.method).toBe("POST");
    const body = JSON.parse(options.body);
    expect(body.input).toEqual(["hello"]);
    expect(body.model).toBe("test-model");
  });

  it("should handle batch embedding (multiple texts)", async () => {
    const embeddings = [
      Array.from({ length: 4 }, () => Math.random()),
      Array.from({ length: 4 }, () => Math.random()),
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: embeddings.map((e, i) => ({ embedding: e, index: i })),
      }),
    });

    const client = createEmbeddingClient({
      apiBase: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "test-model",
    });

    const result = await client.embed(["hello", "world"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(embeddings[0]);
    expect(result[1]).toEqual(embeddings[1]);
  });

  it("should throw on API error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Invalid API key",
    });

    const client = createEmbeddingClient({
      apiBase: "https://api.example.com/v1",
      apiKey: "bad-key",
      model: "test-model",
    });

    await expect(client.embed(["hello"])).rejects.toThrow();
  });
});
