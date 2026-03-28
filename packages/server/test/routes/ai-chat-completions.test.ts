import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateKeyPair, getPublicKey } from "@remi/crypto";
import { ConnectionManager } from "../../src/db/connection.js";
import type { ChatClient } from "../../src/llm/client.js";
import type { EmbeddingClient } from "../../src/embedding/client.js";

let tmpDir: string;
let connMgr: ConnectionManager;

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
  routeFactory: typeof import("../../src/routes/ai-chat-completions.js").aiChatCompletionsRoute,
  options: {
    chatClient: ChatClient;
    embeddingClient?: EmbeddingClient | null;
    sseHeartbeatTiming?: { silentMs?: number; intervalMs?: number } | null;
  },
) {
  const app = new Hono();
  app.route(
    "/ai/v1/chat/completions",
    routeFactory({
      connMgr,
      chatClient: options.chatClient,
      embeddingClient: options.embeddingClient ?? null,
      sseHeartbeatTiming: options.sseHeartbeatTiming ?? null,
    }),
  );
  return app;
}

describe("ai chat completions route", () => {
  const ownerPubKey = getPublicKey(generateKeyPair());
  const apiToken = `token-${crypto.randomUUID()}`;

  beforeEach(() => {
    tmpDir = path.join("test-tmp", `ai-chat-completions-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    connMgr = new ConnectionManager(tmpDir, {
      maxSize: 10,
      embeddingDimensions: 4,
    });

    const ownerConn = connMgr.getConnection(ownerPubKey, { create: true });
    ownerConn.raw
      .prepare(`INSERT INTO api_tokens (id, note, created_at) VALUES (?, ?, ?)`)
      .run(apiToken, "test token", new Date().toISOString());
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    connMgr.closeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("aborts upstream streaming work when the SSE transport fails", async () => {
    const releaseRunStream = createDeferred<void>();
    const runStreamStarted = createDeferred<void>();
    let observedSignal: AbortSignal | undefined;

    const chatClient: ChatClient = {
      chat: vi.fn(),
      chatStream: vi.fn(),
    };

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

    const { aiChatCompletionsRoute } = await import("../../src/routes/ai-chat-completions.js");
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
    const runStreamSpy = vi
      .spyOn(AvatarInferenceRuntime.prototype, "runStream")
      .mockImplementation(async function* (request) {
        yield* [] as Array<{ type: "message_start"; message: { role: "assistant" } }>;
        observedSignal = request.signal;
        runStreamStarted.resolve();
        await releaseRunStream.promise;
        throw request.signal?.reason ?? new Error("aborted");
      });

    const app = await createTestApp(aiChatCompletionsRoute, {
      chatClient,
      sseHeartbeatTiming: { silentMs: 10, intervalMs: 10 },
    });

    const responsePromise = app.request("/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        model: `ReMi-${ownerPubKey}`,
        messages: [{ role: "user", content: "你好" }],
        stream: true,
      }),
    });

    await runStreamStarted.promise;
    const transportFailure = new Error("transport closed");
    notifyHeartbeatError?.(transportFailure);
    heartbeatFailure.reject(transportFailure);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runStreamSpy).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);

    releaseRunStream.resolve();
    const res = await responsePromise;
    expect(res.status).toBe(200);
  });
});
