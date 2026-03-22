import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

  function seedReasoningMessage(options: {
    visitorKey: string;
    role: "user" | "assistant";
    content: string;
    recalledAnchors?: string[] | null;
    anchorSelectionStrategy?: "batch-recall" | "full-injection" | null;
  }) {
    const conn = connMgr.getConnection(ownerPubKey);
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
    expect(JSON.parse(done!.data ?? "{}")).toEqual({ messageId: 2, recalledAnchors: [] });
  });

  it("unauthenticated request should return 401", async () => {
    const res = await app.request(`/api/${ownerPubKey}/reasoning/messages`);
    expect(res.status).toBe(401);
  });

  it("GET /reasoning/messages should hide internal strategy field", async () => {
    seedReasoningMessage({
      visitorKey: visitorPubKey,
      role: "assistant",
      content: "hello",
      recalledAnchors: ["a1"],
      anchorSelectionStrategy: "full-injection",
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
      role: "assistant",
      content: "hello",
      recalled_anchors: ["a1"],
      visitor_key: visitorPubKey,
    });
    expect(body.data.items[0]).not.toHaveProperty("anchorSelectionStrategy");
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
});
