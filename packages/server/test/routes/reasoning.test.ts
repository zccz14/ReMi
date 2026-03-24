import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { reasoningRoutes } from "../../src/routes/reasoning.js";
import { ConnectionManager } from "../../src/db/connection.js";
import { upsertEmbedding } from "../../src/embedding/index.js";
import type { ChatClient } from "../../src/llm/client.js";
import type { EmbeddingClient } from "../../src/embedding/client.js";
import { generateKeyPair, getPublicKey } from "@remi/crypto";
import * as fs from "fs";
import * as path from "path";

let tmpDir: string;
let connMgr: ConnectionManager;
const testPubKey = getPublicKey(generateKeyPair());
const visitorPubKey = getPublicKey(generateKeyPair());

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

function seedDirectMessage(options: {
  partyAKey: string;
  partyBKey: string;
  senderKey: string;
  senderKind?: "owner" | "avatar";
  body: { type: string; version: number; text?: string; content?: string; [key: string]: unknown };
  createdAt?: number;
}) {
  const normalizedPartyAKey =
    options.partyAKey < options.partyBKey ? options.partyAKey : options.partyBKey;
  const normalizedPartyBKey =
    options.partyAKey < options.partyBKey ? options.partyBKey : options.partyAKey;
  const createdAt = options.createdAt ?? Date.now();
  const ciphertext = Buffer.from(JSON.stringify(options.body), "utf8").toString("base64");
  const sharedMessageId = crypto.randomUUID();
  const messageHash = crypto.randomUUID().split("-").join("");

  for (const pubKey of new Set([normalizedPartyAKey, normalizedPartyBKey])) {
    connMgr
      .getConnection(pubKey, { create: true })
      .raw.prepare(
        `INSERT INTO direct_messages (
          shared_message_id,
          party_a_key,
          party_b_key,
          sender_key,
          sender_kind,
          ciphertext_a,
          ciphertext_b,
          ciphertext_c,
          message_hash,
          prev_message_hash,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sharedMessageId,
        normalizedPartyAKey,
        normalizedPartyBKey,
        options.senderKey,
        options.senderKind ?? "owner",
        ciphertext,
        ciphertext,
        ciphertext,
        messageHash,
        null,
        createdAt,
      );
  }
}

function seedReasoningMessage(options: {
  visitorKey: string;
  role: "user" | "assistant";
  content: string;
  recalledAnchors?: string[] | null;
  anchorSelectionStrategy?: "batch-recall" | "full-injection" | null;
}) {
  seedDirectMessage({
    partyAKey: testPubKey < options.visitorKey ? testPubKey : options.visitorKey,
    partyBKey: testPubKey < options.visitorKey ? options.visitorKey : testPubKey,
    senderKey: options.role === "user" ? options.visitorKey : testPubKey,
    senderKind: options.role === "assistant" ? "avatar" : "owner",
    body: {
      type: "text",
      version: 1,
      text: options.content,
      recalledAnchors: options.recalledAnchors ?? undefined,
      anchorSelectionStrategy: options.anchorSelectionStrategy ?? undefined,
    },
  });
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

  it("GET /reasoning/messages filters by stable party keys", async () => {
    seedDirectMessage({
      partyAKey: testPubKey,
      partyBKey: visitorPubKey,
      senderKey: visitorPubKey,
      body: { type: "text", version: 1, text: "visible" },
    });
    seedDirectMessage({
      partyAKey: "another-owner",
      partyBKey: visitorPubKey,
      senderKey: visitorPubKey,
      body: { type: "text", version: 1, text: "hidden" },
    });

    const app = createTestApp(visitorPubKey);
    const res = await app.request(`/api/${testPubKey}/reasoning/messages`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({
      sender_key: visitorPubKey,
      sender_kind: "owner",
      shared_message_id: expect.any(String),
      content: "visible",
      created_at: expect.any(Number),
    });
    expect(body.data.items[0]).not.toHaveProperty("ciphertext_c");
  });

  it("GET /reasoning/messages keeps external path and returns compatible body mapping", async () => {
    seedDirectMessage({
      partyAKey: testPubKey,
      partyBKey: visitorPubKey,
      senderKey: testPubKey,
      senderKind: "avatar",
      body: { type: "text", version: 1, text: "你好" },
    });

    const app = createTestApp(visitorPubKey);
    const res = await app.request(`/api/${testPubKey}/reasoning/messages`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({
      shared_message_id: expect.any(String),
      sender_key: testPubKey,
      sender_kind: "avatar",
      content: "你好",
      body: { type: "text", version: 1, text: "你好" },
      created_at: expect.any(Number),
    });
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

  it("POST /reasoning/message dual-writes owner and visitor replicas with a chained fact log", async () => {
    const chatClient = {
      chat: vi.fn().mockResolvedValue({
        content:
          "<judgment><sufficient>true</sufficient><next_query></next_query><narrative>thinking</narrative><reason>ok</reason></judgment>",
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
      chatStream: vi.fn(async function* () {
        yield "reply";
      }),
    };

    const app = createTestApp(visitorPubKey, { chatClient });
    const firstRes = await app.request(`/api/${testPubKey}/reasoning/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body_json: { type: "text", version: 1, text: "first" } }),
    });
    expect(firstRes.status).toBe(200);
    await firstRes.text();

    const secondRes = await app.request(`/api/${testPubKey}/reasoning/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body_json: { type: "text", version: 1, text: "second" } }),
    });
    expect(secondRes.status).toBe(200);
    await secondRes.text();

    const ownerRows = connMgr
      .getConnection(testPubKey)
      .raw.prepare(
        `SELECT shared_message_id, message_hash, prev_message_hash, party_a_key, party_b_key, sender_key, delivered_at_a, delivered_at_b
         FROM direct_messages
         ORDER BY id ASC`,
      )
      .all() as Array<Record<string, string | number | null>>;
    const visitorRows = connMgr
      .getConnection(visitorPubKey)
      .raw.prepare(
        `SELECT shared_message_id, message_hash, prev_message_hash, party_a_key, party_b_key, sender_key, delivered_at_a, delivered_at_b
         FROM direct_messages
         ORDER BY id ASC`,
      )
      .all() as Array<Record<string, string | number | null>>;

    expect(ownerRows).toHaveLength(4);
    expect(visitorRows).toEqual(ownerRows);
    const expectedPartyAKey = testPubKey < visitorPubKey ? testPubKey : visitorPubKey;
    const expectedPartyBKey = testPubKey < visitorPubKey ? visitorPubKey : testPubKey;
    expect(ownerRows.every((row) => row.party_a_key === expectedPartyAKey)).toBe(true);
    expect(ownerRows.every((row) => row.party_b_key === expectedPartyBKey)).toBe(true);
    expect(ownerRows.every((row) => typeof row.delivered_at_a === "number")).toBe(true);
    expect(ownerRows.every((row) => typeof row.delivered_at_b === "number")).toBe(true);
    expect(ownerRows[1]?.prev_message_hash).toBe(ownerRows[0]?.message_hash);
    expect(ownerRows[2]?.prev_message_hash).toBe(ownerRows[1]?.message_hash);
    expect(ownerRows[3]?.prev_message_hash).toBe(ownerRows[2]?.message_hash);
  });

  it("POST /reasoning/message rolls back the first replica when the second replica write fails", async () => {
    const chatClient = {
      chat: vi.fn().mockResolvedValue({
        content:
          "<judgment><sufficient>true</sufficient><next_query></next_query><narrative>thinking</narrative><reason>ok</reason></judgment>",
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
      chatStream: vi.fn(async function* () {
        yield "reply";
      }),
    };

    const visitorConn = connMgr.getConnection(visitorPubKey, { create: true });
    const originalPrepare = visitorConn.raw.prepare.bind(visitorConn.raw);
    vi.spyOn(visitorConn.raw, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO direct_messages")) {
        throw new Error("replica write failed");
      }
      return originalPrepare(sql);
    });

    const app = createTestApp(visitorPubKey, { chatClient });
    const res = await app.request(`/api/${testPubKey}/reasoning/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body_json: { type: "text", version: 1, text: "first" } }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"code":"LLM_ERROR"');
    expect(
      connMgr
        .getConnection(testPubKey)
        .raw.prepare(`SELECT COUNT(*) AS count FROM direct_messages`)
        .get(),
    ).toEqual({ count: 0 });
  });
});
