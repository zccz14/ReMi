import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { reasoningRoutes } from "../../src/routes/reasoning.js";
import { AvatarInferenceRuntime } from "../../src/avatar/runtime.js";
import { ConnectionManager } from "../../src/db/connection.js";
import type { ChatClient } from "../../src/llm/client.js";
import type { EmbeddingClient } from "../../src/embedding/client.js";
import { generateKeyPair, getPublicKey } from "@remi/crypto";
import * as fs from "fs";
import * as path from "path";
import { decodeStoredBody } from "../../src/messaging/runtime.js";
import { subscribeToLogs, type StructuredLogRecord } from "../../src/logger.js";
import { isReasoningGapProbeEnabledForOwner } from "../../src/config/feature-flags.js";

let tmpDir: string;
let connMgr: ConnectionManager;
const testPubKey = getPublicKey(generateKeyPair());
const visitorPubKey = getPublicKey(generateKeyPair());

function createTestApp(
  signerPubKey: string,
  options: {
    chatClient?: ChatClient | null;
    embeddingClient?: EmbeddingClient | null;
    sseHeartbeatTiming?: { silentMs?: number; intervalMs?: number } | null;
  } = {},
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("signerPubKey", signerPubKey);
    c.set("role", signerPubKey === testPubKey ? "owner" : "visitor");
    c.set("connMgr", connMgr);
    c.set("embeddingClient", options.embeddingClient ?? null);
    c.set("chatClient", options.chatClient ?? null);
    c.set("sseHeartbeatTiming", options.sseHeartbeatTiming ?? null);
    await next();
  });
  app.route("/api", reasoningRoutes);
  return app;
}

function createChatClient(): ChatClient {
  return {
    chat: vi.fn(),
    chatStream: vi.fn(),
  };
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

function listStoredBodies(pubKey: string) {
  const rows = connMgr
    .getConnection(pubKey, { create: true })
    .raw.prepare(`SELECT sender_key, ciphertext_c FROM direct_messages ORDER BY id ASC`)
    .all() as Array<{ sender_key: string; ciphertext_c: string }>;

  return rows.map((row) => ({
    senderKey: row.sender_key,
    body: decodeStoredBody(row.ciphertext_c),
  }));
}

function listCandidateRows(pubKey: string) {
  return connMgr
    .getConnection(pubKey, { create: true })
    .raw.prepare(`SELECT question, answer, source FROM soul_candidate_queue ORDER BY rowid ASC`)
    .all() as Array<{ question: string; answer: string | null; source: string }>;
}

function findEvents(records: StructuredLogRecord[], event: string) {
  return records.filter((record) => record.event === event || record.alertType === event);
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
    vi.restoreAllMocks();
    delete process.env.REMI_REASONING_GAP_PROBE_OWNERS;
    connMgr.closeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enables reasoning probes only for allowlisted owners", () => {
    process.env.REMI_REASONING_GAP_PROBE_OWNERS = `${testPubKey},owner-b`;

    expect(isReasoningGapProbeEnabledForOwner(testPubKey)).toBe(true);
    expect(isReasoningGapProbeEnabledForOwner("owner-c")).toBe(false);
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

  it("POST /reasoning/message maps stored conversation turns into unified runtime input", async () => {
    seedReasoningMessage({
      visitorKey: visitorPubKey,
      role: "user",
      content: "第一轮提问",
    });
    seedReasoningMessage({
      visitorKey: visitorPubKey,
      role: "assistant",
      content: "第一轮回答",
    });

    const createRequestSpy = vi
      .spyOn(AvatarInferenceRuntime.prototype, "createRequest")
      .mockResolvedValue({
        avatarTarget: { publicKey: testPubKey },
        instructionSegments: {
          platform: "platform",
          avatar: "avatar",
          recall: "recall",
        },
        conversationTurns: [],
        contentParts: [],
        stream: true,
      });
    vi.spyOn(AvatarInferenceRuntime.prototype, "getPreparedReasoningMetadata").mockReturnValue({
      thinkingNarratives: [],
      recalledAnchorIds: ["anchor-1"],
      anchorSelectionStrategy: "batch-recall",
    });
    vi.spyOn(AvatarInferenceRuntime.prototype, "runStream").mockImplementation(async function* () {
      yield { type: "message_start", message: { role: "assistant" } };
      yield { type: "text_delta", text: "reply" };
      yield { type: "message_end", finishReason: "stop" };
    });
    const app = createTestApp(visitorPubKey, { chatClient: createChatClient() });

    const res = await app.request(`/api/${testPubKey}/reasoning/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "继续聊" }),
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(createRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        avatarTarget: { publicKey: testPubKey },
        conversationTurns: [
          { role: "user", content: "第一轮提问" },
          { role: "assistant", content: "第一轮回答" },
          { role: "user", content: "继续聊" },
        ],
        initialAnchors: [],
        stream: true,
        visitorKey: visitorPubKey,
      }),
    );
  });

  it("POST /reasoning/message forwards runtime thinking/token/done and stores runtime metadata", async () => {
    vi.spyOn(AvatarInferenceRuntime.prototype, "createRequest").mockResolvedValue({
      avatarTarget: { publicKey: testPubKey },
      instructionSegments: {
        platform: "platform",
        avatar: "avatar",
        recall: "recall",
      },
      conversationTurns: [],
      contentParts: [],
      stream: true,
    });
    vi.spyOn(AvatarInferenceRuntime.prototype, "getPreparedReasoningMetadata").mockReturnValue({
      thinkingNarratives: ["thinking"],
      recalledAnchorIds: ["anchor-1", "anchor-2"],
      anchorSelectionStrategy: "batch-recall",
    });
    vi.spyOn(AvatarInferenceRuntime.prototype, "runStream").mockImplementation(async function* () {
      yield { type: "message_start", message: { role: "assistant" } };
      yield { type: "text_delta", text: "hel" };
      yield { type: "text_delta", text: "lo" };
      yield { type: "message_end", finishReason: "stop" };
    });

    const app = createTestApp(visitorPubKey, { chatClient: createChatClient() });
    const res = await app.request(`/api/${testPubKey}/reasoning/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "你好" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: thinking");
    expect(text).toContain("data: thinking");
    expect(text).toContain("event: token");
    expect(text).toContain("data: hel");
    expect(text).toContain("data: lo");
    expect(text).toContain("event: done");
    expect(text).toContain('"recalledAnchors":["anchor-1","anchor-2"]');

    const storedBodies = listStoredBodies(visitorPubKey);
    expect(storedBodies).toHaveLength(2);
    expect(storedBodies[0]).toMatchObject({
      senderKey: visitorPubKey,
      body: { type: "text", version: 1, text: "你好" },
    });
    expect(storedBodies[1]).toMatchObject({
      senderKey: testPubKey,
      body: {
        type: "text",
        version: 1,
        text: "hello",
        recalledAnchors: ["anchor-1", "anchor-2"],
        anchorSelectionStrategy: "batch-recall",
      },
    });
  });

  it("creates reasoning probe candidates for the reasoning route", async () => {
    vi.resetModules();
    process.env.REMI_REASONING_GAP_PROBE_OWNERS = testPubKey;

    class FakeAvatarInferenceRuntime {
      constructor(
        private deps: {
          flushReasoningProbes?: (batch: {
            pendingReasoningProbes: Array<{
              displayQuestion: string;
              canonicalQuestion: string;
              kind: string;
              sourceRef: string | null;
              sourceSnapshot: Record<string, unknown> | null;
            }>;
            probeStats: { rawDraftCount: number; droppedCount: number };
          }) => Promise<void> | void;
        },
      ) {}

      async createRequest(input: Record<string, unknown>) {
        return input;
      }

      getPreparedReasoningMetadata() {
        return {
          thinkingNarratives: [],
          recalledAnchorIds: [],
          anchorSelectionStrategy: "batch-recall",
        };
      }

      async *runStream() {
        await this.deps.flushReasoningProbes?.({
          pendingReasoningProbes: [
            {
              displayQuestion: "我还缺什么判断标准？",
              canonicalQuestion: "我还缺什么判断标准？",
              kind: "judgment-gap",
              sourceRef: "goal:criteria",
              sourceSnapshot: { goalId: "criteria" },
            },
          ],
          probeStats: { rawDraftCount: 3, droppedCount: 2 },
        });
        yield { type: "message_start", message: { role: "assistant" } };
        yield { type: "text_delta", text: "hello" };
        yield { type: "message_end", finishReason: "stop" };
      }
    }

    vi.doMock("../../src/avatar/runtime.js", () => ({
      AvatarInferenceRuntime: FakeAvatarInferenceRuntime,
    }));

    const { reasoningRoutes: mockedReasoningRoutes } =
      await import("../../src/routes/reasoning.js");
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("signerPubKey", visitorPubKey);
      c.set("role", "visitor");
      c.set("connMgr", connMgr);
      c.set("embeddingClient", null);
      c.set("chatClient", createChatClient());
      await next();
    });
    app.route("/api", mockedReasoningRoutes);

    const res = await app.request(`/api/${testPubKey}/reasoning/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "你好" }),
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(listCandidateRows(testPubKey)).toEqual([
      expect.objectContaining({
        question: "我还缺什么判断标准？",
        answer: null,
        source: "reasoning",
      }),
    ]);
  });

  it("does not create reasoning probes when the owner is not allowlisted", async () => {
    vi.resetModules();

    class FakeAvatarInferenceRuntime {
      constructor(
        private deps: {
          flushReasoningProbes?: (
            probes: Array<{
              displayQuestion: string;
              canonicalQuestion: string;
              kind: string;
              sourceRef: string | null;
              sourceSnapshot: Record<string, unknown> | null;
            }>,
          ) => Promise<void> | void;
        },
      ) {}

      async createRequest(input: Record<string, unknown>) {
        return input;
      }

      getPreparedReasoningMetadata() {
        return {
          thinkingNarratives: [],
          recalledAnchorIds: [],
          anchorSelectionStrategy: "batch-recall",
        };
      }

      async *runStream() {
        await this.deps.flushReasoningProbes?.([
          {
            displayQuestion: "我还缺什么判断标准？",
            canonicalQuestion: "我还缺什么判断标准？",
            kind: "judgment-gap",
            sourceRef: "goal:criteria",
            sourceSnapshot: { goalId: "criteria" },
          },
        ]);
        yield { type: "message_start", message: { role: "assistant" } };
        yield { type: "text_delta", text: "hello" };
        yield { type: "message_end", finishReason: "stop" };
      }
    }

    vi.doMock("../../src/avatar/runtime.js", () => ({
      AvatarInferenceRuntime: FakeAvatarInferenceRuntime,
    }));

    const { reasoningRoutes: mockedReasoningRoutes } =
      await import("../../src/routes/reasoning.js");
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("signerPubKey", visitorPubKey);
      c.set("role", "visitor");
      c.set("connMgr", connMgr);
      c.set("embeddingClient", null);
      c.set("chatClient", createChatClient());
      await next();
    });
    app.route("/api", mockedReasoningRoutes);

    const res = await app.request(`/api/${testPubKey}/reasoning/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "你好" }),
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(listCandidateRows(testPubKey)).toEqual([]);
  });

  it("records reasoning probe lifecycle events", async () => {
    process.env.REMI_REASONING_GAP_PROBE_OWNERS = testPubKey;
    const records: StructuredLogRecord[] = [];
    const unsubscribe = subscribeToLogs((record) => {
      records.push(record);
    });
    const createRequestSpy = vi
      .spyOn(AvatarInferenceRuntime.prototype, "createRequest")
      .mockImplementation(async function (input) {
        const request = {
          avatarTarget: input.avatarTarget,
          instructionSegments: {
            platform: "platform",
            avatar: "avatar",
            recall: "recall",
          },
          conversationTurns: input.conversationTurns,
          contentParts: [] as [],
          stream: input.stream,
          signal: input.signal,
        };

        (
          this as unknown as {
            preparedInferenceByRequest: WeakMap<object, object>;
          }
        ).preparedInferenceByRequest.set(request, {
          request,
          currentTime: new Date(0).toISOString(),
          userQuery: "你好",
          requiredGoalIds: [],
          finalAnchorIds: [],
          anchorSelectionStrategy: "recall-loop",
          rounds: 0,
          goalStatus: [],
          recallRounds: [],
          turns: [],
          thinkingNarratives: [],
          pendingReasoningProbes: [
            {
              displayQuestion: "我还缺什么判断标准？",
              canonicalQuestion: "我还缺什么判断标准？",
              kind: "judgment-gap",
              sourceRef: "goal:criteria",
              sourceSnapshot: { goalId: "criteria" },
            },
          ],
          probeStats: { rawDraftCount: 3, droppedCount: 2 },
        });

        return request;
      });
    vi.spyOn(AvatarInferenceRuntime.prototype, "getPreparedReasoningMetadata").mockReturnValue({
      thinkingNarratives: [],
      recalledAnchorIds: [],
      anchorSelectionStrategy: "batch-recall",
    });

    try {
      const app = createTestApp(visitorPubKey, {
        chatClient: {
          chat: vi.fn(),
          chatStream: vi.fn(async function* () {
            yield "hello";
          }),
        },
      });
      const res = await app.request(`/api/${testPubKey}/reasoning/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "你好" }),
      });

      expect(res.status).toBe(200);
      await res.text();

      expect(createRequestSpy).toHaveBeenCalled();
      expect(findEvents(records, "reasoning_probe_generated")).toHaveLength(1);
      expect(findEvents(records, "reasoning_probe_candidate_created")).toHaveLength(0);
      expect(findEvents(records, "reasoning_probe_candidate_create_failed")).toHaveLength(0);
      expect(findEvents(records, "reasoning_probe_generated")[0]).toEqual(
        expect.objectContaining({
          ownerKey: testPubKey,
          requestId: expect.any(String),
          streamMode: "stream",
          probeCount: 1,
          droppedCount: 2,
          createSuccessCount: 1,
          createFailureCount: 0,
          latencyDeltaMs: expect.any(Number),
        }),
      );
    } finally {
      unsubscribe();
    }
  });

  it("POST /reasoning/message fails fast when prepared reasoning metadata is missing", async () => {
    vi.spyOn(AvatarInferenceRuntime.prototype, "createRequest").mockResolvedValue({
      avatarTarget: { publicKey: testPubKey },
      instructionSegments: {
        platform: "platform",
        avatar: "avatar",
        recall: "recall",
      },
      conversationTurns: [],
      contentParts: [],
      stream: true,
    });
    vi.spyOn(AvatarInferenceRuntime.prototype, "getPreparedReasoningMetadata").mockImplementation(
      () => undefined,
    );
    const runStreamSpy = vi
      .spyOn(AvatarInferenceRuntime.prototype, "runStream")
      .mockImplementation(async function* () {
        yield { type: "message_start", message: { role: "assistant" } };
        yield { type: "text_delta", text: "should-not-run" };
        yield { type: "message_end", finishReason: "stop" };
      });

    const app = createTestApp(visitorPubKey, { chatClient: createChatClient() });
    const res = await app.request(`/api/${testPubKey}/reasoning/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "你好" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain('"code":"LLM_ERROR"');
    expect(text).toContain("Prepared reasoning metadata missing");
    expect(text).not.toContain("event: done");
    expect(runStreamSpy).not.toHaveBeenCalled();

    const storedBodies = listStoredBodies(visitorPubKey);
    expect(storedBodies).toHaveLength(1);
    expect(storedBodies[0]).toMatchObject({
      senderKey: visitorPubKey,
      body: { type: "text", version: 1, text: "你好" },
    });
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
