import { describe, it, expect, vi } from "vitest";
import { ReasoningEngine } from "../../src/reasoning/engine.js";
import type { ChatResponse } from "../../src/llm/client.js";
import type { SoulAnchor } from "../../src/types.js";

const THRESHOLD = 20;

function createAnchor(id: string, question: string): SoulAnchor {
  return {
    id,
    question,
    answer: `${question} 的答案`,
    source: "interview",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function createMockDeps() {
  const chatClient = {
    chat: vi.fn().mockResolvedValue({
      content: `<judgment><sufficient>true</sufficient><next_query></next_query><narrative>思考中...</narrative><reason>ok</reason></judgment>`,
      finishReason: "stop",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    } satisfies ChatResponse),
    chatStream: vi.fn(async function* () {
      yield "你好";
      yield "，我是分身";
    }),
  };
  const embeddingClient = {
    embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
  };
  const deps = {
    chatClient,
    embeddingClient,
    countAnchors: vi.fn().mockResolvedValue(THRESHOLD + 1),
    listAnchors: vi.fn().mockResolvedValue([]),
    getMessages: vi.fn().mockResolvedValue([]),
    saveMessage: vi
      .fn()
      .mockResolvedValueOnce({ messageId: 1, sharedMessageId: "shared-user" })
      .mockResolvedValueOnce({ messageId: 2, sharedMessageId: "shared-assistant" }),
    searchAnchors: vi.fn().mockResolvedValue([]),
    getCachedAnchorIds: vi.fn().mockResolvedValue([]),
    getAnchorsByIds: vi.fn().mockResolvedValue([]),
  };
  return deps;
}

describe("ReasoningEngine", () => {
  it("should run handleMessage flow", async () => {
    const deps = createMockDeps();
    const events: { type: string; data: unknown }[] = [];

    const engine = new ReasoningEngine(deps);

    const emitter = {
      emitThinking: (n: string) => {
        events.push({ type: "thinking", data: n });
      },
      emitToken: (t: string) => {
        events.push({ type: "token", data: t });
      },
      emitDone: (d: unknown) => {
        events.push({ type: "done", data: d });
      },
      emitError: (code: string, msg: string) => {
        events.push({ type: "error", data: { code, msg } });
      },
    };

    await engine.handleMessage("你好", "visitor-pub-key", emitter);

    const tokenEvents = events.filter((e) => e.type === "token");
    expect(tokenEvents.length).toBeGreaterThan(0);

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect((doneEvent!.data as { messageId: number }).messageId).toBe(2);
    expect(deps.getCachedAnchorIds).toHaveBeenCalled();
  });

  it("should emit error on LLM failure", async () => {
    const deps = createMockDeps();
    deps.chatClient.chat.mockRejectedValue(new Error("LLM down"));

    const events: { type: string; data: unknown }[] = [];

    const engine = new ReasoningEngine(deps);

    const emitter = {
      emitThinking: vi.fn(),
      emitToken: vi.fn(),
      emitDone: vi.fn(),
      emitError: (code: string, msg: string) => {
        events.push({ type: "error", data: { code, msg } });
      },
    };

    await engine.handleMessage("test", "visitor-key", emitter);

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent!.data as { code: string }).code).toBe("LLM_ERROR");
  });

  it("should use full injection and skip recall loop at threshold while allowing assessment", async () => {
    const deps = createMockDeps();
    deps.saveMessage.mockReset();
    deps.saveMessage
      .mockResolvedValueOnce({ messageId: 1, sharedMessageId: "shared-user" })
      .mockResolvedValueOnce({ messageId: 2, sharedMessageId: "shared-assistant" });
    const anchors = [createAnchor("a1", "我是谁"), createAnchor("a2", "我的风格")];
    deps.countAnchors.mockResolvedValue(THRESHOLD);
    deps.listAnchors.mockResolvedValue(anchors);

    const emitThinking = vi.fn();
    const emitToken = vi.fn();
    const emitDone = vi.fn();
    const emitter = {
      emitThinking,
      emitToken,
      emitDone,
      emitError: vi.fn(),
    };

    const engine = new ReasoningEngine(deps);

    await engine.handleMessage("你好", "visitor-key", emitter);

    expect(deps.getCachedAnchorIds).not.toHaveBeenCalled();
    expect(deps.chatClient.chat).toHaveBeenCalledTimes(1);
    expect(deps.embeddingClient.embed).not.toHaveBeenCalled();
    expect(deps.listAnchors).toHaveBeenCalled();
    expect(emitThinking).toHaveBeenCalledWith("思考中...");
    expect(emitDone).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 2, recalledAnchors: ["a1", "a2"] }),
    );
  });

  it("should allow full injection without embedding client", async () => {
    const deps = createMockDeps();
    deps.saveMessage.mockReset();
    deps.saveMessage
      .mockResolvedValueOnce({ messageId: 1, sharedMessageId: "shared-user" })
      .mockResolvedValueOnce({ messageId: 2, sharedMessageId: "shared-assistant" });
    deps.countAnchors.mockResolvedValue(0);
    deps.listAnchors.mockResolvedValue([createAnchor("a1", "我是谁")]);
    const depsWithoutEmbedding = { ...deps, embeddingClient: undefined };

    const events: { type: string; data: unknown }[] = [];
    const emitter = {
      emitThinking: vi.fn(),
      emitToken: (t: string) => {
        events.push({ type: "token", data: t });
      },
      emitDone: (d: unknown) => {
        events.push({ type: "done", data: d });
      },
      emitError: (code: string, msg: string) => {
        events.push({ type: "error", data: { code, msg } });
      },
    };

    const engine = new ReasoningEngine(depsWithoutEmbedding);

    await engine.handleMessage("你好", "visitor-key", emitter);

    expect(events.some((e) => e.type === "token")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("should emit clear error when recall path lacks embedding client", async () => {
    const deps = createMockDeps();
    deps.countAnchors.mockResolvedValue(THRESHOLD + 1);
    const depsWithoutEmbedding = { ...deps, embeddingClient: undefined };
    const emitError = vi.fn();
    const emitter = {
      emitThinking: vi.fn(),
      emitToken: vi.fn(),
      emitDone: vi.fn(),
      emitError,
    };

    const engine = new ReasoningEngine(depsWithoutEmbedding);

    await engine.handleMessage("test", "visitor-key", emitter);

    expect(emitError).toHaveBeenCalledWith(
      "LLM_ERROR",
      expect.stringContaining("Embedding client not configured for recall loop"),
    );
  });

  it("should persist anchor selection strategy for assistant message", async () => {
    const deps = createMockDeps();
    deps.saveMessage.mockReset();
    deps.saveMessage
      .mockResolvedValueOnce({ messageId: 1, sharedMessageId: "shared-user" })
      .mockResolvedValueOnce({ messageId: 2, sharedMessageId: "shared-assistant" });
    deps.countAnchors.mockResolvedValue(0);
    deps.listAnchors.mockResolvedValue([createAnchor("a1", "我是谁")]);
    const engine = new ReasoningEngine(deps);

    await engine.handleMessage("hello", "visitor-key", {
      emitThinking: vi.fn(),
      emitToken: vi.fn(),
      emitDone: vi.fn(),
      emitError: vi.fn(),
    });

    expect(deps.saveMessage).toHaveBeenNthCalledWith(
      2,
      "visitor-key",
      "assistant",
      "你好，我是分身",
      ["a1"],
      "full-injection",
    );
  });
});
