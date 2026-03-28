import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createApp } from "@remi/server/app";
import { generateKeyPair, getPublicKey, sign, buildStringToSign } from "@remi/crypto";
import { upsertEmbedding } from "../packages/server/src/embedding/index.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Hono } from "hono";

describe("reasoning integration", () => {
  let tmpDir: string;
  let app: Hono;
  let cleanup: () => void;
  let connMgr: ReturnType<typeof createApp>["connMgr"];
  let ownerPrivKey: string;
  let ownerPubKey: string;
  let visitorPrivKey: string;
  let visitorPubKey: string;

  function createChatClient() {
    return {
      chat: async () => ({
        content:
          "<judgment><sufficient>true</sufficient><next_query></next_query><narrative>thinking</narrative><reason>ok</reason></judgment>",
        finishReason: "stop" as const,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
      chatStream: async function* () {
        yield "你好";
        yield "，我是分身";
      },
    };
  }

  function createRecallAwareEmbeddingClient() {
    let gate: Promise<void> | null = null;

    return {
      client: {
        async embed(texts: string[]) {
          if (gate) {
            await gate;
          }
          return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
        },
      },
      blockRecall(nextGate: Promise<void>) {
        gate = nextGate;
      },
    };
  }

  function parseSSE(text: string) {
    return text
      .trim()
      .split("\n\n")
      .filter(Boolean)
      .map((block) => {
        const event = block
          .split("\n")
          .find((line) => line.startsWith("event:"))
          ?.replace("event:", "")
          .trim();
        const data = block
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.replace("data:", "")
          .trim();
        return { event, data };
      });
  }

  function lastDoneEvent(text: string) {
    const done = parseSSE(text).find((event) => event.event === "done");
    return done ? JSON.parse(done.data ?? "{}") : null;
  }

  async function readWithTimeout<T>(promise: Promise<T>, timeoutMs: number) {
    return Promise.race<T | "timeout">([
      promise,
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  }

  function seedAnchor(id: string, question: string, withEmbedding = true) {
    const conn = connMgr.getConnection(ownerPubKey);
    const now = Date.now();
    conn.raw
      .prepare(
        `INSERT INTO soul_anchors (id, question, answer, source, created_at, updated_at)
         VALUES (?, ?, ?, 'interview', ?, ?)`,
      )
      .run(id, question, `${question} 的答案`, now, now);
    if (withEmbedding) {
      upsertEmbedding(conn.raw, "soul_anchors_vec", id, [0.1, 0.2, 0.3, 0.4]);
    }
  }

  function seedDirectMessage(options: {
    partyAKey: string;
    partyBKey: string;
    senderKey: string;
    senderKind?: "owner" | "avatar";
    body: {
      type: string;
      version: number;
      text?: string;
      content?: string;
      [key: string]: unknown;
    };
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
      partyAKey: ownerPubKey < options.visitorKey ? ownerPubKey : options.visitorKey,
      partyBKey: ownerPubKey < options.visitorKey ? options.visitorKey : ownerPubKey,
      senderKey: options.role === "user" ? options.visitorKey : ownerPubKey,
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

  async function signedRequest(
    method: string,
    urlPath: string,
    privKey: string,
    pubKey: string,
    body?: string,
  ) {
    const timestamp = String(Date.now());
    const bodyBytes = body ? new TextEncoder().encode(body) : undefined;
    const pathname = urlPath.split("?")[0];
    const sts = await buildStringToSign(method, pathname, timestamp, bodyBytes);
    const signature = await sign(new TextEncoder().encode(sts), privKey);

    const headers: Record<string, string> = {
      "X-Public-Key": pubKey,
      "X-Timestamp": timestamp,
      "X-Signature": signature,
    };
    if (body) headers["Content-Type"] = "application/json";

    return app.request(urlPath, { method, headers, body: body ?? undefined });
  }

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `remi-reasoning-integ-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const result = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      chatClient: createChatClient(),
      embeddingClient: null,
    });
    app = result.app;
    connMgr = result.connMgr;
    cleanup = () => result.connMgr.closeAll();

    ownerPrivKey = generateKeyPair();
    ownerPubKey = getPublicKey(ownerPrivKey);
    visitorPrivKey = generateKeyPair();
    visitorPubKey = getPublicKey(visitorPrivKey);

    // Create owner's soul by making an owner request
    await signedRequest("GET", `/api/${ownerPubKey}/health`, ownerPrivKey, ownerPubKey);
  });

  afterEach(() => {
    cleanup();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("GET /reasoning/messages should return empty initially", async () => {
    const res = await signedRequest(
      "GET",
      `/api/${ownerPubKey}/reasoning/messages`,
      visitorPrivKey,
      visitorPubKey,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toEqual([]);
    expect(body.data.hasMore).toBe(false);
  });

  it("POST /reasoning/message should stream done payload in cold-start path without embedding client", async () => {
    const res = await signedRequest(
      "POST",
      `/api/${ownerPubKey}/reasoning/message`,
      visitorPrivKey,
      visitorPubKey,
      JSON.stringify({ content: "你好" }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const events = parseSSE(text);
    const done = events.find((event) => event.event === "done");
    expect(done).toBeDefined();
    expect(JSON.parse(done!.data ?? "{}")).toMatchObject({ messageId: 2, recalledAnchors: [] });
  });

  it("POST /reasoning/message emits comment heartbeat while runtime prep is blocked", async () => {
    const embedding = createRecallAwareEmbeddingClient();
    const result = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      chatClient: createChatClient(),
      embeddingClient: embedding.client,
      sseHeartbeatTiming: { silentMs: 10, intervalMs: 10 },
    });
    app = result.app;
    connMgr = result.connMgr;
    cleanup = () => result.connMgr.closeAll();

    for (let i = 1; i <= 21; i++) {
      seedAnchor(`anchor-${i}`, `问题 ${i}`);
    }

    let releaseRecall!: () => void;
    const recallGate = new Promise<void>((resolve) => {
      releaseRecall = resolve;
    });
    embedding.blockRecall(recallGate);

    const res = await signedRequest(
      "POST",
      `/api/${ownerPubKey}/reasoning/message`,
      visitorPrivKey,
      visitorPubKey,
      JSON.stringify({ content: "你好" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const firstChunkResult = await readWithTimeout(reader.read(), 200);
    expect(firstChunkResult).not.toBe("timeout");
    expect(typeof firstChunkResult).toBe("object");
    expect(firstChunkResult).toMatchObject({ done: false });

    const decoder = new TextDecoder();
    const firstChunkText = decoder.decode(
      (firstChunkResult as ReadableStreamReadResult<Uint8Array>).value,
      { stream: true },
    );

    expect(firstChunkText).toContain(":\n\n");
    expect(firstChunkText).not.toContain("event: done");
    expect(firstChunkText).not.toContain("event: token");

    releaseRecall();

    let remainingText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      remainingText += decoder.decode(value, { stream: true });
    }
    remainingText += decoder.decode();

    const done = lastDoneEvent(firstChunkText + remainingText);
    expect(done).toMatchObject({ messageId: 2, recalledAnchors: expect.any(Array) });
  });

  it("POST /reasoning/message exits stream quietly when heartbeat transport fails", async () => {
    vi.resetModules();
    vi.doMock("../packages/server/src/lib/sse-heartbeat.js", () => ({
      createSseHeartbeat(options: { onError?: (error: unknown) => void }) {
        let rejectFailure!: (error: unknown) => void;
        const failure = new Promise<never>((_, reject) => {
          rejectFailure = reject;
        });
        failure.catch(() => {});

        return {
          start() {
            const error = new Error("mock heartbeat transport failure");
            options.onError?.(error);
            rejectFailure(error);
          },
          stop() {},
          recordRealWrite() {},
          get failure() {
            return failure;
          },
        };
      },
    }));

    try {
      const { createApp: createIsolatedApp } = await import("@remi/server/app");
      const isolated = createIsolatedApp({
        dataDir: tmpDir,
        embeddingDimensions: 4,
        chatClient: createChatClient(),
        embeddingClient: null,
      });

      app = isolated.app;
      connMgr = isolated.connMgr;
      cleanup = () => isolated.connMgr.closeAll();

      const res = await signedRequest(
        "POST",
        `/api/${ownerPubKey}/reasoning/message`,
        visitorPrivKey,
        visitorPubKey,
        JSON.stringify({ content: "你好" }),
      );

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain("event: error");
      expect(text).not.toContain('"code":"LLM_ERROR"');
    } finally {
      vi.doUnmock("../packages/server/src/lib/sse-heartbeat.js");
      vi.resetModules();
    }
  });

  it("unauthenticated request should return 401", async () => {
    const res = await app.request(`/api/${ownerPubKey}/reasoning/messages`);
    expect(res.status).toBe(401);
  });

  it("GET /reasoning/messages should read direct_messages and hide ciphertext_c", async () => {
    seedDirectMessage({
      partyAKey: ownerPubKey < visitorPubKey ? ownerPubKey : visitorPubKey,
      partyBKey: ownerPubKey < visitorPubKey ? visitorPubKey : ownerPubKey,
      senderKey: ownerPubKey,
      senderKind: "avatar",
      body: { type: "text", version: 1, text: "hello" },
    });

    const res = await signedRequest(
      "GET",
      `/api/${ownerPubKey}/reasoning/messages`,
      visitorPrivKey,
      visitorPubKey,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items[0]).toMatchObject({
      shared_message_id: expect.any(String),
      sender_key: ownerPubKey,
      sender_kind: "avatar",
      content: "hello",
      body: { type: "text", version: 1, text: "hello" },
      created_at: expect.any(Number),
    });
    expect(body.data.items[0]).not.toHaveProperty("ciphertext_c");
  });

  it("reasoning recall should reuse legacy null cache and ignore full-injection cache", async () => {
    const result = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      chatClient: createChatClient(),
      embeddingClient: {
        embed: async () => [[0.1, 0.2, 0.3, 0.4]],
      },
    });
    app = result.app;
    connMgr = result.connMgr;
    cleanup = () => result.connMgr.closeAll();

    seedAnchor("anchor-1", "问题 1", true);
    seedAnchor("anchor-2", "问题 2", false);
    for (let i = 3; i <= 21; i++) {
      seedAnchor(`anchor-${i}`, `问题 ${i}`, false);
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

    const res = await signedRequest(
      "POST",
      `/api/${ownerPubKey}/reasoning/message`,
      visitorPrivKey,
      visitorPubKey,
      JSON.stringify({ content: "继续聊" }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"recalledAnchors":["anchor-1"]');
    expect(text).not.toContain("anchor-2");
  });

  it("POST /reasoning/message accepts body_json and writes matching replicas for both participants", async () => {
    const res = await signedRequest(
      "POST",
      `/api/${ownerPubKey}/reasoning/message`,
      visitorPrivKey,
      visitorPubKey,
      JSON.stringify({ body_json: { type: "text", version: 1, text: "你好" } }),
    );
    expect(res.status).toBe(200);
    const done = lastDoneEvent(await res.text());
    expect(done).toMatchObject({
      messageId: expect.any(Number),
      shared_message_id: expect.any(String),
    });

    const ownerRows = connMgr
      .getConnection(ownerPubKey)
      .raw.prepare(
        `SELECT shared_message_id, message_hash, prev_message_hash, sender_key FROM direct_messages ORDER BY id ASC`,
      )
      .all() as Array<Record<string, string | null>>;
    const visitorRows = connMgr
      .getConnection(visitorPubKey)
      .raw.prepare(
        `SELECT shared_message_id, message_hash, prev_message_hash, sender_key FROM direct_messages ORDER BY id ASC`,
      )
      .all() as Array<Record<string, string | null>>;

    expect(ownerRows).toEqual(visitorRows);
    expect(ownerRows).toHaveLength(2);
    expect(ownerRows[1]).toMatchObject({
      prev_message_hash: ownerRows[0]?.message_hash,
      sender_key: ownerPubKey,
    });
  });

  it("read and attest routes replicate receipts and integrity reports healthy then tampered", async () => {
    const sendRes = await signedRequest(
      "POST",
      `/api/${ownerPubKey}/reasoning/message`,
      visitorPrivKey,
      visitorPubKey,
      JSON.stringify({ body_json: { type: "text", version: 1, text: "你好" } }),
    );
    expect(sendRes.status).toBe(200);
    const done = lastDoneEvent(await sendRes.text()) as { shared_message_id: string };

    const readRes = await signedRequest(
      "POST",
      `/api/${ownerPubKey}/reasoning/messages/${done.shared_message_id}/read`,
      visitorPrivKey,
      visitorPubKey,
      JSON.stringify({}),
    );
    expect(readRes.status).toBe(200);

    const messageHashRow = connMgr
      .getConnection(ownerPubKey)
      .raw.prepare(
        `SELECT message_hash, read_at_a, read_at_b FROM direct_messages WHERE shared_message_id = ?`,
      )
      .get(done.shared_message_id) as {
      message_hash: string;
      read_at_a: number | null;
      read_at_b: number | null;
    };
    const signature = await sign(Buffer.from(messageHashRow.message_hash, "hex"), visitorPrivKey);

    const attestRes = await signedRequest(
      "POST",
      `/api/${ownerPubKey}/reasoning/messages/${done.shared_message_id}/attest`,
      visitorPrivKey,
      visitorPubKey,
      JSON.stringify({ signature }),
    );
    expect(attestRes.status).toBe(200);

    const ownerReplica = connMgr
      .getConnection(ownerPubKey)
      .raw.prepare(
        `SELECT read_at_a, read_at_b, attested_at_a, attested_at_b, sign_a, sign_b FROM direct_messages WHERE shared_message_id = ?`,
      )
      .get(done.shared_message_id);
    const visitorReplica = connMgr
      .getConnection(visitorPubKey)
      .raw.prepare(
        `SELECT read_at_a, read_at_b, attested_at_a, attested_at_b, sign_a, sign_b FROM direct_messages WHERE shared_message_id = ?`,
      )
      .get(done.shared_message_id);

    const visitorSlot = ownerPubKey < visitorPubKey ? "b" : "a";
    const readKey = visitorSlot === "a" ? "read_at_a" : "read_at_b";
    const attestKey = visitorSlot === "a" ? "attested_at_a" : "attested_at_b";
    const signKey = visitorSlot === "a" ? "sign_a" : "sign_b";

    expect(ownerReplica).toEqual(visitorReplica);
    expect(ownerReplica?.[readKey as keyof typeof ownerReplica]).toEqual(expect.any(Number));
    expect(ownerReplica?.[attestKey as keyof typeof ownerReplica]).toEqual(expect.any(Number));
    expect(ownerReplica?.[signKey as keyof typeof ownerReplica]).toBe(signature);

    const healthyRes = await signedRequest(
      "GET",
      `/api/${ownerPubKey}/reasoning/integrity`,
      visitorPrivKey,
      visitorPubKey,
    );
    expect(healthyRes.status).toBe(200);
    await expect(healthyRes.json()).resolves.toMatchObject({
      data: {
        status: "healthy",
        blocked: false,
        conflicts: 0,
        tampered: 0,
      },
    });

    connMgr
      .getConnection(visitorPubKey)
      .raw.prepare(`UPDATE direct_messages SET ciphertext_c = ? WHERE shared_message_id = ?`)
      .run("AAAA", done.shared_message_id);

    const tamperedRes = await signedRequest(
      "GET",
      `/api/${ownerPubKey}/reasoning/integrity`,
      visitorPrivKey,
      visitorPubKey,
    );
    expect(tamperedRes.status).toBe(200);
    await expect(tamperedRes.json()).resolves.toMatchObject({
      data: {
        status: "tampered",
        tampered: 1,
      },
    });
  });
});
