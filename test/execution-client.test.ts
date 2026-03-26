import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionClient } from "../packages/server/src/goals/execution-client";

const mockFetch = vi.fn();

describe("execution client", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  function createClient() {
    return createExecutionClient({
      baseUrl: "https://exec.example.test/root/",
      rootSeed: "remi-execution-root-seed-test-vector-1",
      userIdentityPubkey: "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw",
      now: () => 1770000000123,
      nonce: () => "nonce-fixed-001",
      fetch: mockFetch,
    });
  }

  it("signs GET /health", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            status: "ok",
            execution_trust_pubkey: "2rFdZJVwAWeaaZVjz2zCL6h61s7ByvXPFZ1wS6cqiXnR",
            version: "0.1.0",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = createClient();
    await expect(client.health()).resolves.toEqual({
      status: "ok",
      executionTrustPubkey: "2rFdZJVwAWeaaZVjz2zCL6h61s7ByvXPFZ1wS6cqiXnR",
      version: "0.1.0",
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://exec.example.test/health");
    expect(options.method).toBe("GET");
    expect(options.body).toBeUndefined();
    expect(options.headers).toMatchObject({
      "X-Remi-Timestamp": "1770000000123",
      "X-Remi-Nonce": "nonce-fixed-001",
      "X-Remi-Body-SHA256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "X-Remi-Signature":
        "ReeN1xxfK49j+C8VIAox3FyLxv7YPuacE/U5ln7UmlGGyOMiECKbuywUI39f1DZ0YhHmYUVRKJLgoWotgDNlBw==",
      "X-Remi-Execution-Pubkey": "2rFdZJVwAWeaaZVjz2zCL6h61s7ByvXPFZ1wS6cqiXnR",
    });
  });

  it("signs POST /sessions and normalizes the response", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            session_id: "sess-new",
            status: "running",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = createClient();
    await expect(
      client.createSession({
        title: "Draft hiring plan",
        objective: "Keep moving",
        initialContext: "Current constraints and context",
        metadata: {
          remi_node_id: "node-1",
          user_identity_pubkey: "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw",
        },
      }),
    ).resolves.toEqual({ sessionId: "sess-new", status: "running" });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://exec.example.test/sessions");
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Remi-Body-SHA256": "b9b006f58cb7d6190baf2591e45520d078376e4599be1f711d92026118ba114b",
    });
    expect(JSON.parse(options.body)).toEqual({
      title: "Draft hiring plan",
      objective: "Keep moving",
      initial_context: "Current constraints and context",
      metadata: {
        remi_node_id: "node-1",
        user_identity_pubkey: "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw",
      },
    });
  });

  it("signs POST /sessions/status/batch and rejects unknown execution statuses", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            items: [
              { session_id: "sess-1", status: "idle", updated_at: 1770000000000 },
              { session_id: "sess-2", status: "paused", updated_at: 1770000001000 },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = createClient();
    await expect(client.getSessionStatuses(["sess-1", "sess-2"])).rejects.toThrow(
      'unknown execution status: "paused"',
    );

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://exec.example.test/sessions/status/batch");
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Remi-Body-SHA256": "f57b1f008ebccf3202b4e9080c702c0b3ece4608873a5a2bd092a5a1d530a806",
      "X-Remi-Signature":
        "xjZKsHAcfTa1511V+uj/oj+int/HLfxik3H6Eyrm2P3hIKiAe98cJ3tipaJz/s7iCzeT3elsGG8Hgsgn8DmyAw==",
    });
    expect(options.body).toBe('{"session_ids":["sess-1","sess-2"]}');
  });

  it("signs GET /sessions/:id/messages with query params", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            items: [{ id: "msg-1", role: "user", content: "continue", created_at: 1770000000000 }],
            has_more: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = createClient();
    await expect(client.getSessionMessages("sess-1", { cursor: "c1", limit: 20 })).resolves.toEqual(
      {
        items: [{ id: "msg-1", role: "user", content: "continue", createdAt: 1770000000000 }],
        hasMore: false,
      },
    );

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://exec.example.test/sessions/sess-1/messages?cursor=c1&limit=20");
    expect(options.method).toBe("GET");
    expect(options.headers).toMatchObject({
      "X-Remi-Body-SHA256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "X-Remi-Signature":
        "tm9tFxZRTU8BAli6Yiw7utHMr/wnoUQRhqFwqOU0i2COj3UCIjmceNbkkMqH1bYzNLTbY6Z9m6CX1Zv6KhKBBw==",
    });
  });

  it("signs POST /sessions/:id/messages and rejects non-idle execution-layer responses", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "session is already running" } }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = createClient();
    await expect(client.appendSessionMessage("sess-1", "continue the work")).rejects.toThrow(
      "execution session is not idle: 409",
    );

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://exec.example.test/sessions/sess-1/messages");
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Remi-Body-SHA256": "40e79b8832b7665193aa8a8b44539eb1baecee30393682c46a54c97d1a248e9d",
      "X-Remi-Signature":
        "sFpfCvKCdKg2cl/b/rI4SiXUvEqtANMGTEXsbevF1S7MkLhZEK0UsOva2EqIgiATnHkdMN0ngu8ZxiG6Md63BA==",
    });
    expect(options.body).toBe('{"content":"continue the work"}');
  });
});
