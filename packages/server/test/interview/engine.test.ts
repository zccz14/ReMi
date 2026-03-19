import { describe, it, expect, vi } from "vitest";
import { InterviewEngine } from "../../src/interview/engine.js";
import type { ChatClient } from "../../src/llm/client.js";

function createMockDeps() {
  const chatClient: ChatClient = {
    chat: vi.fn().mockResolvedValue({
      content: JSON.stringify({ sufficient: true, reason: "ok", narrative: "thinking..." }),
      finishReason: "stop",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    }),
    chatStream: vi.fn().mockReturnValue(
      (async function* () {
        yield "回复";
        yield "内容";
      })(),
    ),
  };
  const embeddingClient = {
    embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
  };
  return { chatClient, embeddingClient };
}

describe("InterviewEngine", () => {
  it("should run start flow (cold start)", async () => {
    const { chatClient, embeddingClient } = createMockDeps();
    const engine = new InterviewEngine({
      chatClient,
      embeddingClient,
      getMessages: async () => [],
      saveMessage: vi.fn().mockResolvedValue(1),
      getAnchors: async () => [],
      saveAnchors: vi.fn(),
      searchAnchors: async () => [],
      getAnchorCount: async () => 0,
    });

    const events: { type: string; data: unknown }[] = [];
    await engine.start({
      emitThinking: (n) => {
        events.push({ type: "thinking", data: n });
      },
      emitToken: (c) => {
        events.push({ type: "token", data: c });
      },
      emitDone: (d) => {
        events.push({ type: "done", data: d });
      },
      emitError: (code, msg) => {
        events.push({ type: "error", data: { code, msg } });
      },
    });

    expect(events.some((e) => e.type === "token")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("should run message flow with extraction", async () => {
    const { chatClient, embeddingClient } = createMockDeps();
    // Override chat mock for sequential calls:
    // 1st: extraction response
    // 2nd: recall judgment
    // 3rd: contradiction detection
    (chatClient.chat as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        content: JSON.stringify({ anchors: [{ question: "价值观", answer: "诚实" }] }),
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ sufficient: true, reason: "ok", narrative: "想好了" }),
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ contradictions: [] }),
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      });

    // Need to re-mock chatStream for this test since the generator can only be consumed once
    (chatClient.chatStream as ReturnType<typeof vi.fn>).mockReturnValue(
      (async function* () {
        yield "回复";
        yield "内容";
      })(),
    );

    const savedAnchors: unknown[] = [];
    const engine = new InterviewEngine({
      chatClient,
      embeddingClient,
      getMessages: async () => [
        { id: 1, role: "assistant" as const, content: "你好", created_at: Date.now() },
      ],
      saveMessage: vi.fn().mockResolvedValue(2),
      getAnchors: async () => [],
      saveAnchors: vi.fn().mockImplementation((a) => savedAnchors.push(...a)),
      searchAnchors: async () => [],
      getAnchorCount: async () => 0,
    });

    const events: { type: string; data: unknown }[] = [];
    await engine.handleMessage("我觉得诚实很重要", {
      emitThinking: (n) => {
        events.push({ type: "thinking", data: n });
      },
      emitToken: (c) => {
        events.push({ type: "token", data: c });
      },
      emitDone: (d) => {
        events.push({ type: "done", data: d });
      },
      emitError: () => {},
    });

    expect(savedAnchors.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === "thinking")).toBe(true);
  });
});
