import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateKeyPair, getPublicKey } from "@remi/crypto";
import { ConnectionManager } from "../../src/db/connection.js";
import type { ChatClient } from "../../src/llm/client.js";
import { decodeStoredBody } from "../../src/messaging/runtime.js";

let tmpDir: string;
let connMgr: ConnectionManager;
const ownerPubKey = getPublicKey(generateKeyPair());
const visitorPubKey = getPublicKey(generateKeyPair());

type RuntimeWithPrivateFlush = {
  flushReasoningProbesBestEffort: (request: unknown) => void;
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function createTestApp(
  reasoningRoutes: typeof import("../../src/routes/reasoning.js").reasoningRoutes,
  chatClient: ChatClient,
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("signerPubKey", visitorPubKey);
    c.set("role", "visitor");
    c.set("connMgr", connMgr);
    c.set("embeddingClient", null);
    c.set("chatClient", chatClient);
    c.set("sseHeartbeatTiming", { silentMs: 10, intervalMs: 10 });
    await next();
  });
  app.route("/api", reasoningRoutes);
  return app;
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

describe("reasoning route transport cancellation", () => {
  beforeEach(() => {
    tmpDir = path.join("test-tmp", `reasoning-transport-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    connMgr = new ConnectionManager(tmpDir, {
      maxSize: 10,
      embeddingDimensions: 4,
    });
    connMgr.getConnection(ownerPubKey, { create: true });
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    delete process.env.REMI_REASONING_GAP_PROBE_OWNERS;
    connMgr.closeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not wait for probe flushing before the transport response is established", async () => {
    const flushRelease = createDeferred<void>();

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
          anchorSelectionStrategy: "batch-recall" as const,
        };
      }

      async *runStream() {
        yield { type: "message_start", message: { role: "assistant" } } as const;
        yield { type: "text_delta", text: "hello" } as const;
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
          probeStats: { rawDraftCount: 1, droppedCount: 0 },
        });
        await flushRelease.promise;
        yield { type: "message_end", finishReason: "stop" } as const;
      }
    }

    vi.doMock("../../src/avatar/runtime.js", () => ({
      AvatarInferenceRuntime: FakeAvatarInferenceRuntime,
    }));

    const { reasoningRoutes } = await import("../../src/routes/reasoning.js");

    const app = await createTestApp(reasoningRoutes, {
      chat: vi.fn(),
      chatStream: vi.fn(async function* () {
        yield "hello";
      }),
    });

    const res = await app.request(`/api/${ownerPubKey}/reasoning/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "你好" }),
    });

    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const firstChunk = await Promise.race([
      reader!.read(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("first stream chunk was blocked by probe flush")), 100);
      }),
    ]);
    const chunkText = Buffer.from(firstChunk.value ?? new Uint8Array()).toString("utf8");

    expect(chunkText).toContain("event: token");

    flushRelease.resolve();
    let restText = "";
    while (true) {
      const nextChunk = await reader!.read();
      if (nextChunk.done) {
        break;
      }
      restText += Buffer.from(nextChunk.value).toString("utf8");
    }
    expect(`${chunkText}${restText}`).toContain("event: done");
  });

  it("does not create reasoning probes when the stream is cancelled before the first token", async () => {
    const heartbeatFailure = createDeferred<never>();
    let notifyHeartbeatError: ((error: unknown) => void) | undefined;

    vi.doMock("../../src/lib/sse-heartbeat.js", () => ({
      createSseHeartbeat: (options: { onError?: (error: unknown) => void }) => {
        notifyHeartbeatError = options.onError;
        return {
          start() {},
          stop() {},
          recordRealWrite() {},
          failure: heartbeatFailure.promise,
        };
      },
    }));

    vi.doUnmock("../../src/avatar/runtime.js");

    const { reasoningRoutes } = await import("../../src/routes/reasoning.js");
    const { AvatarInferenceRuntime } = await import("../../src/avatar/runtime.js");

    const flushSpy = vi.spyOn(
      AvatarInferenceRuntime.prototype as unknown as RuntimeWithPrivateFlush,
      "flushReasoningProbesBestEffort",
    );
    vi.spyOn(AvatarInferenceRuntime.prototype, "createRequest").mockImplementation(
      async (input) => ({
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
      }),
    );
    vi.spyOn(AvatarInferenceRuntime.prototype, "getPreparedReasoningMetadata").mockReturnValue({
      thinkingNarratives: [],
      recalledAnchorIds: [],
      anchorSelectionStrategy: "batch-recall",
    });
    vi.spyOn(AvatarInferenceRuntime.prototype, "runStream").mockImplementation(async function* () {
      yield* [] as never[];
      const transportFailure = new Error("heartbeat write failed before first token");
      notifyHeartbeatError?.(transportFailure);
      heartbeatFailure.reject(transportFailure);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return;
    });

    const app = await createTestApp(reasoningRoutes, {
      chat: vi.fn(),
      chatStream: vi.fn(),
    });

    const res = await app.request(`/api/${ownerPubKey}/reasoning/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "你好" }),
    });

    expect(res.status).toBe(200);
    expect(flushSpy).not.toHaveBeenCalled();
  });

  it("does not persist assistant output after heartbeat failure", async () => {
    const flowRelease = createDeferred<void>();
    const flowStarted = createDeferred<void>();
    const heartbeatFailure = createDeferred<never>();
    let notifyHeartbeatError: ((error: unknown) => void) | undefined;

    vi.doMock("../../src/lib/sse-heartbeat.js", () => ({
      createSseHeartbeat: (options: { onError?: (error: unknown) => void }) => {
        notifyHeartbeatError = options.onError;
        return {
          start() {},
          stop() {},
          recordRealWrite() {},
          failure: heartbeatFailure.promise,
        };
      },
    }));

    const { reasoningRoutes } = await import("../../src/routes/reasoning.js");
    const { AvatarInferenceRuntime } = await import("../../src/avatar/runtime.js");

    const createRequestSpy = vi
      .spyOn(AvatarInferenceRuntime.prototype, "createRequest")
      .mockImplementation(async (input) => ({
        avatarTarget: input.avatarTarget,
        instructionSegments: {
          platform: "platform",
          avatar: "avatar",
          recall: "recall",
        },
        conversationTurns: input.conversationTurns,
        contentParts: [],
        stream: input.stream,
        signal: input.signal,
      }));
    vi.spyOn(AvatarInferenceRuntime.prototype, "getPreparedReasoningMetadata").mockReturnValue({
      thinkingNarratives: [],
      recalledAnchorIds: [],
      anchorSelectionStrategy: "batch-recall",
    });
    vi.spyOn(AvatarInferenceRuntime.prototype, "runStream").mockImplementation(async function* () {
      yield { type: "message_start", message: { role: "assistant" } };
      flowStarted.resolve();
      await flowRelease.promise;
      yield { type: "message_end", finishReason: "stop" };
    });

    const app = await createTestApp(reasoningRoutes, {
      chat: vi.fn(),
      chatStream: vi.fn(),
    });

    const responsePromise = app.request(`/api/${ownerPubKey}/reasoning/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "你好" }),
    });

    await flowStarted.promise;
    const transportFailure = new Error("heartbeat write failed");
    notifyHeartbeatError?.(transportFailure);
    heartbeatFailure.reject(transportFailure);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const signal = createRequestSpy.mock.calls[0]?.[0].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);

    flowRelease.resolve();
    const res = await responsePromise;
    expect(res.status).toBe(200);

    const storedBodies = listStoredBodies(visitorPubKey);
    expect(storedBodies).toHaveLength(1);
    expect(storedBodies[0]).toMatchObject({
      senderKey: visitorPubKey,
      body: { type: "text", version: 1, text: "你好" },
    });
  });

  it("removes the just-persisted assistant message when transport fails during assistant persistence", async () => {
    const heartbeatFailure = createDeferred<never>();
    let notifyHeartbeatError: ((error: unknown) => void) | undefined;

    vi.doMock("../../src/lib/sse-heartbeat.js", () => ({
      createSseHeartbeat: (options: { onError?: (error: unknown) => void }) => {
        notifyHeartbeatError = options.onError;
        return {
          start() {},
          stop() {},
          recordRealWrite() {},
          failure: heartbeatFailure.promise,
        };
      },
    }));

    const { reasoningRoutes } = await import("../../src/routes/reasoning.js");
    const { AvatarInferenceRuntime } = await import("../../src/avatar/runtime.js");

    vi.spyOn(AvatarInferenceRuntime.prototype, "createRequest").mockImplementation(
      async (input) => ({
        avatarTarget: input.avatarTarget,
        instructionSegments: {
          platform: "platform",
          avatar: "avatar",
          recall: "recall",
        },
        conversationTurns: input.conversationTurns,
        contentParts: [],
        stream: input.stream,
        signal: input.signal,
      }),
    );
    vi.spyOn(AvatarInferenceRuntime.prototype, "getPreparedReasoningMetadata").mockReturnValue({
      thinkingNarratives: [],
      recalledAnchorIds: [],
      anchorSelectionStrategy: "batch-recall",
    });
    vi.spyOn(AvatarInferenceRuntime.prototype, "runStream").mockImplementation(async function* () {
      yield { type: "message_start", message: { role: "assistant" } };
      yield { type: "text_delta", text: "reply" };
      yield { type: "message_end", finishReason: "stop" };
    });

    const visitorConn = connMgr.getConnection(visitorPubKey, { create: true });
    const originalPrepare = visitorConn.raw.prepare.bind(visitorConn.raw);
    vi.spyOn(visitorConn.raw, "prepare").mockImplementation((sql: string) => {
      const statement = originalPrepare(sql);
      if (!sql.includes("INSERT INTO direct_messages")) {
        return statement;
      }

      return {
        ...statement,
        run: (...args: unknown[]) => {
          const result = statement.run(...args);
          const senderKey = args[3];
          const senderKind = args[4];
          if (senderKey === ownerPubKey && senderKind === "avatar") {
            const transportFailure = new Error("transport closed during assistant persist");
            notifyHeartbeatError?.(transportFailure);
            heartbeatFailure.reject(transportFailure);
          }
          return result;
        },
      };
    });

    const app = await createTestApp(reasoningRoutes, {
      chat: vi.fn(),
      chatStream: vi.fn(),
    });

    const res = await app.request(`/api/${ownerPubKey}/reasoning/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "你好" }),
    });

    expect(res.status).toBe(200);
    await res.text();

    const storedBodies = listStoredBodies(visitorPubKey);
    expect(storedBodies).toHaveLength(1);
    expect(storedBodies[0]).toMatchObject({
      senderKey: visitorPubKey,
      body: { type: "text", version: 1, text: "你好" },
    });
  });
});
