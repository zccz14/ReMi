import { describe, it, expect, vi } from "vitest";
import { ReasoningEngine } from "../../src/reasoning/engine.js";
import type { ChatResponse } from "../../src/llm/client.js";

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
  return { chatClient, embeddingClient };
}

describe("ReasoningEngine", () => {
  it("should run handleMessage flow", async () => {
    const { chatClient, embeddingClient } = createMockDeps();
    const events: { type: string; data: unknown }[] = [];

    const engine = new ReasoningEngine({
      chatClient,
      embeddingClient,
      getMessages: vi.fn().mockResolvedValue([]),
      saveMessage: vi.fn().mockResolvedValue(1),
      searchAnchors: vi.fn().mockResolvedValue([]),
      getCachedAnchorIds: vi.fn().mockResolvedValue([]),
      getAnchorsByIds: vi.fn().mockResolvedValue([]),
    });

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
    expect((doneEvent!.data as { messageId: number }).messageId).toBe(1);
  });

  it("should emit error on LLM failure", async () => {
    const { chatClient, embeddingClient } = createMockDeps();
    chatClient.chat.mockRejectedValue(new Error("LLM down"));

    const events: { type: string; data: unknown }[] = [];

    const engine = new ReasoningEngine({
      chatClient,
      embeddingClient,
      getMessages: vi.fn().mockResolvedValue([]),
      saveMessage: vi.fn().mockResolvedValue(1),
      searchAnchors: vi.fn().mockResolvedValue([]),
      getCachedAnchorIds: vi.fn().mockResolvedValue([]),
      getAnchorsByIds: vi.fn().mockResolvedValue([]),
    });

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
});
