import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { interviewRoutes } from "../../src/routes/interview.js";
import { ConnectionManager } from "../../src/db/connection.js";
import type { ChatClient } from "../../src/llm/client.js";
import type { EmbeddingClient } from "../../src/embedding/client.js";
import { messages, soulAnchors, soulCandidateQueue } from "../../src/db/schema.js";
import { subscribeToLogs, type StructuredLogRecord } from "../../src/logger.js";
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

function captureLogs() {
  const records: StructuredLogRecord[] = [];
  const unsubscribe = subscribeToLogs((record) => {
    records.push(record);
  });
  return { records, unsubscribe };
}

function findEvents(records: StructuredLogRecord[], event: string) {
  return records.filter((record) => record.event === event || record.alertType === event);
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

  it("POST /api/:pubKey/interview/message creates approval candidates instead of formal anchors", async () => {
    const chatClient: ChatClient = {
      chat: async () => ({
        content:
          "<judgment><sufficient>true</sufficient><next_query></next_query><narrative>ok</narrative></judgment><anchor><question>用户最近在做什么</question><answer>在做测试</answer></anchor>",
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
      body: JSON.stringify({ content: "我最近在做测试" }),
    });

    expect(res.status).toBe(200);
    await res.text();

    const conn = connMgr.getConnection(PUB_KEY);
    const queued = conn.drizzle.select().from(soulCandidateQueue).all();
    const formal = conn.drizzle.select().from(soulAnchors).all();

    expect(queued).toEqual([
      expect.objectContaining({
        question: "我最近在做什么",
        answer: "在做测试",
        source: "interview",
      }),
    ]);
    expect(queued[0]?.sourceRef).toBeTruthy();
    expect(queued[0]?.sourceSnapshot).toContain("我最近在做测试");
    expect(formal).toHaveLength(0);
  });

  it("records interview candidate creation through the approval gateway", async () => {
    const chatClient: ChatClient = {
      chat: async () => ({
        content:
          "<judgment><sufficient>true</sufficient><next_query></next_query><narrative>ok</narrative></judgment><anchor><question>用户最近在做什么</question><answer>在做测试</answer></anchor>",
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
    const { records, unsubscribe } = captureLogs();

    try {
      const res = await app.request(`/api/${PUB_KEY}/interview/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "我最近在做测试" }),
      });

      expect(res.status).toBe(200);
      await res.text();

      expect(findEvents(records, "candidate_created")[0]).toEqual(
        expect.objectContaining({
          ownerKey: PUB_KEY,
          source: "interview",
        }),
      );
    } finally {
      unsubscribe();
    }
  });

  it("POST /api/:pubKey/interview/start keeps current embedding dependency boundary", async () => {
    const chatClient: ChatClient = {
      chat: async () => ({
        content:
          "<judgment><sufficient>true</sufficient><next_query></next_query><narrative>ok</narrative></judgment>",
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
      chatStream: async function* () {
        yield "你好";
      },
    };

    const app = createTestApp(connMgr, PUB_KEY, { chatClient, embeddingClient: null });
    const res = await app.request(`/api/${PUB_KEY}/interview/start`, { method: "POST" });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("LLM_ERROR");
  });

  it("POST /api/:pubKey/interview/message keeps current embedding dependency boundary", async () => {
    const chatClient: ChatClient = {
      chat: async () => ({
        content:
          "<judgment><sufficient>true</sufficient><next_query></next_query><narrative>ok</narrative></judgment>",
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
      chatStream: async function* () {
        yield "你好";
      },
    };

    const app = createTestApp(connMgr, PUB_KEY, { chatClient, embeddingClient: null });
    const res = await app.request(`/api/${PUB_KEY}/interview/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("LLM_ERROR");
  });

  it("interview anchor loading uses stable updatedAt ordering", async () => {
    const conn = connMgr.getConnection(PUB_KEY);
    conn.drizzle
      .insert(soulAnchors)
      .values([
        {
          id: "older",
          question: "旧问题",
          answer: "旧答案",
          source: "interview",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "newer",
          question: "新问题",
          answer: "新答案",
          source: "interview",
          createdAt: 2,
          updatedAt: 2,
        },
      ])
      .run();

    const chatMessages: { role: string; content: string }[][] = [];
    const chatClient: ChatClient = {
      chat: async () => ({
        content:
          "<judgment><sufficient>true</sufficient><next_query></next_query><narrative>ok</narrative></judgment>",
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
      chatStream: async function* ({ messages }) {
        chatMessages.push(messages);
        yield "你好";
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
    await res.text();

    const systemPrompt = chatMessages[chatMessages.length - 1]?.[0]?.content ?? "";
    expect(systemPrompt.indexOf("新问题")).toBeLessThan(systemPrompt.indexOf("旧问题"));
  });

  it("routes outside the gateway do not directly write soulAnchors", () => {
    const repoRoot = path.resolve(__dirname, "../../src/routes");
    const routeFiles = ["approval.ts", "anchors.ts", "interview.ts"];
    const directWritePattern = /(?:insert|update|delete)\(soulAnchors\)/;

    for (const routeFile of routeFiles) {
      const content = fs.readFileSync(path.join(repoRoot, routeFile), "utf8");
      expect(content).not.toMatch(directWritePattern);
    }
  });
});
