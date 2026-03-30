import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateKeyPair, getPublicKey } from "@remi/crypto";
import { ConnectionManager } from "../../src/db/connection.js";
import type { ChatClient } from "../../src/llm/client.js";
import type { EmbeddingClient } from "../../src/embedding/client.js";
import type { StructuredLogRecord } from "../../src/logger.js";

let tmpDir: string;
let connMgr: ConnectionManager;

type RuntimeWithPreparedMap = {
  preparedInferenceByRequest: WeakMap<object, object>;
};

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

function listCandidateRows(pubKey: string) {
  return connMgr
    .getConnection(pubKey, { create: true })
    .raw.prepare(`SELECT question, answer, source FROM soul_candidate_queue ORDER BY rowid ASC`)
    .all() as Array<{ question: string; answer: string | null; source: string }>;
}

function findEvents(records: StructuredLogRecord[], event: string) {
  return records.filter((record) => record.event === event || record.alertType === event);
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
    delete process.env.REMI_REASONING_GAP_PROBE_OWNERS;
    connMgr.closeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("aborts upstream streaming work when the SSE transport fails", async () => {
    const releaseChatStream = createDeferred<void>();
    const chatStreamStarted = createDeferred<void>();
    let observedSignal: AbortSignal | undefined;

    const chatClient: ChatClient = {
      chat: vi.fn(),
      chatStream: vi.fn(async function* (options) {
        yield* [] as string[];
        observedSignal = options.signal;
        chatStreamStarted.resolve();
        await releaseChatStream.promise;
        throw options.signal?.reason ?? new Error("aborted");
      }),
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

    vi.doUnmock("../../src/avatar/runtime.js");

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

    await chatStreamStarted.promise;
    const transportFailure = new Error("transport closed");
    notifyHeartbeatError?.(transportFailure);
    heartbeatFailure.reject(transportFailure);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chatClient.chatStream).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);

    releaseChatStream.resolve();
    const res = await responsePromise;
    expect(res.status).toBe(200);
  });

  it("creates reasoning probe candidates for chat completions without changing the response schema", async () => {
    vi.resetModules();
    process.env.REMI_REASONING_GAP_PROBE_OWNERS = ownerPubKey;

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

      async run() {
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
        return {
          message: { role: "assistant", content: "你好" },
          finishReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      }
    }

    vi.doMock("../../src/avatar/runtime.js", () => ({
      AvatarInferenceRuntime: FakeAvatarInferenceRuntime,
    }));

    const { aiChatCompletionsRoute } = await import("../../src/routes/ai-chat-completions.js");
    const app = await createTestApp(aiChatCompletionsRoute, {
      chatClient: {
        chat: vi.fn(),
        chatStream: vi.fn(),
      },
    });

    const res = await app.request("/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        model: `ReMi-${ownerPubKey}`,
        messages: [{ role: "user", content: "你好" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();

    expect(listCandidateRows(ownerPubKey)).toEqual([
      expect.objectContaining({
        question: "我还缺什么判断标准？",
        answer: null,
        source: "reasoning",
      }),
    ]);
    expect(json.object).toBe("chat.completion");
  });

  it("does not create reasoning probes for chat completions when the owner is not allowlisted", async () => {
    vi.resetModules();

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

      async run() {
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
        return {
          message: { role: "assistant", content: "你好" },
          finishReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      }
    }

    vi.doMock("../../src/avatar/runtime.js", () => ({
      AvatarInferenceRuntime: FakeAvatarInferenceRuntime,
    }));

    const { aiChatCompletionsRoute } = await import("../../src/routes/ai-chat-completions.js");
    const app = await createTestApp(aiChatCompletionsRoute, {
      chatClient: {
        chat: vi.fn(),
        chatStream: vi.fn(),
      },
    });

    const res = await app.request("/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        model: `ReMi-${ownerPubKey}`,
        messages: [{ role: "user", content: "你好" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    await res.json();
    expect(listCandidateRows(ownerPubKey)).toEqual([]);
  });

  it("always injects a debug artifact writer for chat completions", async () => {
    vi.resetModules();

    const ctorDeps: Array<Record<string, unknown>> = [];
    const createWriterSpy = vi.fn(() => ({
      writeLatest: vi.fn(async () => {}),
      writeLatestRuntimeTrace: vi.fn(async () => {}),
    }));

    class FakeAvatarInferenceRuntime {
      constructor(deps: Record<string, unknown>) {
        ctorDeps.push(deps);
      }

      async createRequest(input: Record<string, unknown>) {
        return input;
      }

      async run() {
        return {
          message: { role: "assistant", content: "你好" },
          finishReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      }
    }

    vi.doMock("../../src/avatar/runtime.js", () => ({
      AvatarInferenceRuntime: FakeAvatarInferenceRuntime,
    }));
    vi.doMock("../../src/reasoning/debug-artifact.js", () => ({
      createLatestReasoningDebugArtifactWriter: createWriterSpy,
    }));

    const { aiChatCompletionsRoute } = await import("../../src/routes/ai-chat-completions.js");
    const app = await createTestApp(aiChatCompletionsRoute, {
      chatClient: {
        chat: vi.fn(),
        chatStream: vi.fn(),
      },
    });

    const res = await app.request("/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        model: `ReMi-${ownerPubKey}`,
        messages: [{ role: "user", content: "你好" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    expect(createWriterSpy).toHaveBeenCalledTimes(1);
    expect(ctorDeps[0]?.debugArtifactWriter).toBeDefined();
  });

  it("records reasoning probe lifecycle events for chat completions without changing the response schema", async () => {
    vi.resetModules();
    process.env.REMI_REASONING_GAP_PROBE_OWNERS = ownerPubKey;

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

      async run() {
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
        return {
          message: { role: "assistant", content: "你好" },
          finishReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      }
    }

    vi.doMock("../../src/avatar/runtime.js", () => ({
      AvatarInferenceRuntime: FakeAvatarInferenceRuntime,
    }));

    const { aiChatCompletionsRoute } = await import("../../src/routes/ai-chat-completions.js");
    const { subscribeToLogs: subscribeToFreshLogs } = await import("../../src/logger.js");
    const records: StructuredLogRecord[] = [];
    const unsubscribe = subscribeToFreshLogs((record) => {
      records.push(record);
    });
    const app = await createTestApp(aiChatCompletionsRoute, {
      chatClient: {
        chat: vi.fn(),
        chatStream: vi.fn(),
      },
    });

    try {
      const res = await app.request("/ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({
          model: `ReMi-${ownerPubKey}`,
          messages: [{ role: "user", content: "你好" }],
          stream: false,
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();

      expect(findEvents(records, "reasoning_probe_generated")).toHaveLength(1);
      expect(findEvents(records, "reasoning_probe_candidate_created")).toHaveLength(0);
      expect(findEvents(records, "reasoning_probe_candidate_create_failed")).toHaveLength(0);
      expect(findEvents(records, "reasoning_probe_generated")[0]).toEqual(
        expect.objectContaining({
          ownerKey: ownerPubKey,
          requestId: expect.any(String),
          streamMode: "non-stream",
          probeCount: 1,
          droppedCount: 2,
          createSuccessCount: 1,
          createFailureCount: 0,
          latencyDeltaMs: expect.any(Number),
        }),
      );
      expect(json.object).toBe("chat.completion");
    } finally {
      unsubscribe();
    }
  });

  it("does not create reasoning probes for chat completions when transport fails before the first token", async () => {
    process.env.REMI_REASONING_GAP_PROBE_OWNERS = ownerPubKey;

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

    const { aiChatCompletionsRoute } = await import("../../src/routes/ai-chat-completions.js");
    const { AvatarInferenceRuntime } = await import("../../src/avatar/runtime.js");

    const flushSpy = vi.spyOn(
      AvatarInferenceRuntime.prototype as unknown as RuntimeWithPrivateFlush,
      "flushReasoningProbesBestEffort",
    );
    vi.spyOn(AvatarInferenceRuntime.prototype, "createRequest").mockImplementation(
      async function (input) {
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

        (this as unknown as RuntimeWithPreparedMap).preparedInferenceByRequest.set(request, {
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
          probeStats: { rawDraftCount: 1, droppedCount: 0 },
        });

        return request;
      },
    );
    vi.spyOn(AvatarInferenceRuntime.prototype, "runStream").mockImplementation(async function* () {
      yield* [] as never[];
      const transportFailure = new Error("heartbeat write failed before first token");
      notifyHeartbeatError?.(transportFailure);
      heartbeatFailure.reject(transportFailure);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return;
    });

    const app = await createTestApp(aiChatCompletionsRoute, {
      chatClient: {
        chat: vi.fn(),
        chatStream: vi.fn(),
      },
      sseHeartbeatTiming: { silentMs: 10, intervalMs: 10 },
    });

    const res = await app.request("/ai/v1/chat/completions", {
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

    expect(res.status).toBe(200);
    expect(flushSpy).not.toHaveBeenCalled();
    expect(listCandidateRows(ownerPubKey)).toEqual([]);
  });
});
