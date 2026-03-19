import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { interviewRoutes } from "../../src/routes/interview.js";
import { ConnectionManager } from "../../src/db/connection.js";
import type { ChatClient } from "../../src/llm/client.js";
import type { EmbeddingClient } from "../../src/embedding/client.js";
import { messages } from "../../src/db/schema.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function createTestApp(
  connMgr: ConnectionManager,
  pubKey: string,
  deps?: { chatClient?: ChatClient | null; embeddingClient?: EmbeddingClient | null },
) {
  const app = new Hono<{
    Variables: {
      signerPubKey: string;
      role: "owner" | "visitor";
      connMgr: ConnectionManager;
      embeddingClient: EmbeddingClient | null;
      chatClient: ChatClient | null;
    };
  }>();
  app.use("/api/:pubKey/*", async (c, next) => {
    c.set("signerPubKey", pubKey);
    c.set("role", pubKey === c.req.param("pubKey") ? "owner" : "visitor");
    c.set("connMgr", connMgr);
    c.set("embeddingClient", deps?.embeddingClient ?? null);
    c.set("chatClient", deps?.chatClient ?? null);
    await next();
  });
  app.route("/api", interviewRoutes);
  return app;
}

describe("interview routes", () => {
  let tmpDir: string;
  let connMgr: ConnectionManager;
  const PUB_KEY = "testOwnerPubKey123";
  const env = { ...process.env };

  beforeEach(() => {
    process.env = { ...env };
    process.env.REMI_CONVERSATION_FLOW_V2 = "full";
    tmpDir = path.join(os.tmpdir(), `remi-interview-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    connMgr = new ConnectionManager(tmpDir, { maxSize: 10, embeddingDimensions: 4 });
    connMgr.getConnection(PUB_KEY, { create: true });
  });

  afterEach(() => {
    process.env = { ...env };
    connMgr.closeAll();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it("GET /api/:pubKey/interview/status → 200 returns stats", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const res = await app.request(`/api/${PUB_KEY}/interview/status`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.totalAnchors).toBe(0);
    expect(json.data.totalMessages).toBe(0);
    expect(json.data.lastActiveAt).toBeNull();
  });

  it("GET /api/:pubKey/interview/messages → 200 returns empty list", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const res = await app.request(`/api/${PUB_KEY}/interview/messages`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.items).toHaveLength(0);
    expect(json.data.hasMore).toBe(false);
  });

  it("GET /api/:pubKey/interview/messages without before returns latest items", async () => {
    const conn = connMgr.getConnection(PUB_KEY);
    conn.drizzle
      .insert(messages)
      .values([
        { role: "assistant", content: "a", createdAt: Date.now() - 1000 },
        { role: "user", content: "b", createdAt: Date.now() },
      ])
      .run();

    const app = createTestApp(connMgr, PUB_KEY);
    const res = await app.request(`/api/${PUB_KEY}/interview/messages?limit=10`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.items).toHaveLength(2);
  });

  it("GET /api/:pubKey/interview/messages rejects invalid limit", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const res = await app.request(`/api/${PUB_KEY}/interview/messages?limit=abc`);
    expect(res.status).toBe(422);
  });

  it("GET /api/:pubKey/interview/messages rejects invalid before", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const res = await app.request(`/api/${PUB_KEY}/interview/messages?before=-1`);
    expect(res.status).toBe(422);
  });

  it("visitor should be rejected with 403", async () => {
    const app = createTestApp(connMgr, "differentPubKey");
    const res = await app.request(`/api/${PUB_KEY}/interview/status`);
    expect(res.status).toBe(403);
  });

  it("POST /api/:pubKey/interview/start streams phase and legacy SSE events", async () => {
    const chatClient: ChatClient = {
      chat: async () => ({
        content:
          "<judgment><sufficient>true</sufficient><next_query></next_query><reason>ok</reason><narrative>thinking...</narrative></judgment>",
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
      chatStream: async function* () {
        yield "你好";
      },
    };
    const embeddingClient: EmbeddingClient = {
      embed: async () => [[0.1, 0.2, 0.3, 0.4]],
    };

    const app = createTestApp(connMgr, PUB_KEY, { chatClient, embeddingClient });
    const res = await app.request(`/api/${PUB_KEY}/interview/start`, { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain("event: phase");
    expect(body).toContain("event: token");
    expect(body).toContain("event: done");
  });

  it("POST /api/:pubKey/interview/message streams phase and legacy SSE events", async () => {
    const chatClient: ChatClient = {
      chat: async () => ({
        content:
          "<judgment><sufficient>true</sufficient><next_query></next_query><reason>ok</reason><narrative>thinking...</narrative></judgment>",
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
      chatStream: async function* () {
        yield "收到";
      },
    };
    const embeddingClient: EmbeddingClient = {
      embed: async () => [[0.1, 0.2, 0.3, 0.4]],
    };

    const app = createTestApp(connMgr, PUB_KEY, { chatClient, embeddingClient });
    const res = await app.request(`/api/${PUB_KEY}/interview/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "你好" }),
    });
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain("event: phase");
    expect(body).toContain("event: token");
    expect(body).toContain("event: done");
  });
});
