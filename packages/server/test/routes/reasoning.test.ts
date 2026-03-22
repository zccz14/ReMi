import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { reasoningRoutes } from "../../src/routes/reasoning.js";
import { ConnectionManager } from "../../src/db/connection.js";
import { upsertEmbedding } from "../../src/embedding/index.js";
import type { ChatClient } from "../../src/llm/client.js";
import type { EmbeddingClient } from "../../src/embedding/client.js";
import * as fs from "fs";
import * as path from "path";

let tmpDir: string;
let connMgr: ConnectionManager;
const testPubKey = "test-pub-key";
const visitorPubKey = "visitor-pub-key";

function createTestApp(
  signerPubKey: string,
  options: { chatClient?: ChatClient | null; embeddingClient?: EmbeddingClient | null } = {},
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("signerPubKey", signerPubKey);
    c.set("role", signerPubKey === testPubKey ? "owner" : "visitor");
    c.set("connMgr", connMgr);
    c.set("embeddingClient", options.embeddingClient ?? null);
    c.set("chatClient", options.chatClient ?? null);
    await next();
  });
  app.route("/api", reasoningRoutes);
  return app;
}

function getOwnerConn() {
  return connMgr.getConnection(testPubKey, { create: true });
}

function seedAnchor(id: string, question: string, options: { withEmbedding?: boolean } = {}) {
  const now = Date.now();
  const conn = getOwnerConn();
  conn.raw
    .prepare(
      `INSERT INTO soul_anchors (id, question, answer, source, created_at, updated_at)
       VALUES (?, ?, ?, 'interview', ?, ?)`,
    )
    .run(id, question, `${question} 的答案`, now, now);
  if (options.withEmbedding !== false) {
    upsertEmbedding(conn.raw, "soul_anchors_vec", id, [0.1, 0.2, 0.3, 0.4]);
  }
}

function seedReasoningMessage(options: {
  visitorKey: string;
  role: "user" | "assistant";
  content: string;
  recalledAnchors?: string[] | null;
  anchorSelectionStrategy?: "batch-recall" | "full-injection" | null;
}) {
  const conn = getOwnerConn();
  conn.raw
    .prepare(
      `INSERT INTO reasoning_messages (
        visitor_key,
        role,
        content,
        recalled_anchors,
        anchor_selection_strategy,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      options.visitorKey,
      options.role,
      options.content,
      options.recalledAnchors ? JSON.stringify(options.recalledAnchors) : null,
      options.anchorSelectionStrategy ?? null,
      Date.now(),
    );
}

describe("reasoning routes", () => {
  beforeEach(() => {
    tmpDir = path.join("test-tmp", "reasoning-routes-" + crypto.randomUUID());
    fs.mkdirSync(tmpDir, { recursive: true });
    connMgr = new ConnectionManager(tmpDir, {
      maxSize: 10,
      embeddingDimensions: 4,
    });
    connMgr.getConnection(testPubKey, { create: true });
  });

  afterEach(() => {
    connMgr.closeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /reasoning/messages -> 200 empty", async () => {
    const app = createTestApp(visitorPubKey);
    const res = await app.request(`/api/${testPubKey}/reasoning/messages`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toEqual([]);
    expect(body.data.hasMore).toBe(false);
  });

  it("GET /reasoning/messages filters by visitor_key", async () => {
    const app = createTestApp(visitorPubKey);
    const res = await app.request(`/api/${testPubKey}/reasoning/messages`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toEqual([]);
  });

  it("GET /reasoning/messages returns populated items without internal strategy field", async () => {
    seedReasoningMessage({
      visitorKey: visitorPubKey,
      role: "assistant",
      content: "你好",
      recalledAnchors: ["a1"],
      anchorSelectionStrategy: "full-injection",
    });

    const app = createTestApp(visitorPubKey);
    const res = await app.request(`/api/${testPubKey}/reasoning/messages`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({
      visitor_key: visitorPubKey,
      role: "assistant",
      content: "你好",
      recalled_anchors: ["a1"],
    });
    expect(body.data.items[0]).not.toHaveProperty("anchorSelectionStrategy");
  });

  it("POST /reasoning/message allows cold-start without embedding client", async () => {
    const chatClient = {
      chat: vi.fn(),
      chatStream: vi.fn(async function* () {
        yield "你好";
      }),
    };
    const app = createTestApp(visitorPubKey, { chatClient });

    const res = await app.request(`/api/${testPubKey}/reasoning/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "你好" }),
    });

    expect(res.status).toBe(200);
    await res.text();
  });

  it("POST /reasoning/message reuses legacy null strategy cache but ignores full-injection cache", async () => {
    seedAnchor("anchor-1", "问题 1");
    seedAnchor("anchor-2", "问题 2", { withEmbedding: false });
    for (let i = 3; i <= 21; i++) {
      seedAnchor(`anchor-${i}`, `问题 ${i}`, { withEmbedding: false });
    }
    seedReasoningMessage({
      visitorKey: visitorPubKey,
      role: "assistant",
      content: "old recall",
      recalledAnchors: ["anchor-1"],
      anchorSelectionStrategy: null,
    });
    seedReasoningMessage({
      visitorKey: visitorPubKey,
      role: "assistant",
      content: "cold start",
      recalledAnchors: ["anchor-2"],
      anchorSelectionStrategy: "full-injection",
    });

    let generationSystemPrompt = "";
    const chatClient = {
      chat: vi.fn().mockResolvedValue({
        content:
          "<judgment><sufficient>true</sufficient><next_query></next_query><narrative>thinking</narrative><reason>ok</reason></judgment>",
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
      chatStream: vi.fn(async function* ({
        messages,
      }: {
        messages: { role: string; content: string }[];
      }) {
        generationSystemPrompt = messages[0]?.content ?? "";
        yield "reply";
      }),
    };
    const embeddingClient = {
      embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]),
    };
    const app = createTestApp(visitorPubKey, { chatClient, embeddingClient });

    const res = await app.request(`/api/${testPubKey}/reasoning/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "继续聊" }),
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(generationSystemPrompt).toContain("问题 1");
    expect(generationSystemPrompt).not.toContain("问题 2");
  });
});
