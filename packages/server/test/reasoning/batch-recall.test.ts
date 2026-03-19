import { describe, it, expect, vi } from "vitest";
import { batchRecall } from "../../src/reasoning/batch-recall.js";
import type { ChatClient, ChatResponse } from "../../src/llm/client.js";
import type { EmbeddingClient } from "../../src/embedding/client.js";
import type { SoulAnchor } from "../../src/types.js";

function xmlJudgment(opts: {
  sufficient: boolean;
  nextQuery?: string;
  narrative?: string;
  reason: string;
}): string {
  return `<judgment>
<sufficient>${opts.sufficient}</sufficient>
<next_query>${opts.nextQuery ?? ""}</next_query>
<narrative>${opts.narrative ?? ""}</narrative>
<reason>${opts.reason}</reason>
</judgment>`;
}

function mockChatClient(...responses: string[]): ChatClient {
  const chat = vi.fn();
  for (const r of responses) {
    chat.mockResolvedValueOnce({
      content: r,
      finishReason: "stop",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    } satisfies ChatResponse);
  }
  return { chat, chatStream: vi.fn() } as unknown as ChatClient;
}

function mockEmbeddingClient(): EmbeddingClient {
  return { embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]) };
}

describe("batchRecall", () => {
  it("should return immediately if all goals sufficient on first round", async () => {
    const onNarrative = vi.fn();
    const client = mockChatClient(
      xmlJudgment({
        sufficient: true,
        narrative: "我已经有足够的了解",
        reason: "all goals met",
      }),
    );

    const result = await batchRecall({
      chatClient: client,
      embeddingClient: mockEmbeddingClient(),
      searchAnchors: vi.fn().mockResolvedValue([]),
      goals: ["identity", "question"],
      context: "test context",
      visitorKey: "test-visitor",
      onNarrative,
    });

    expect(result.sufficient).toBe(true);
    expect(result.rounds).toBe(1);
    expect(onNarrative).toHaveBeenCalledWith("我已经有足够的了解");
  });

  it("should loop until sufficient with multi-goal", async () => {
    const anchor: SoulAnchor = {
      id: "a1",
      question: "我的身份",
      answer: "工程师",
      source: "interview",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const client = mockChatClient(
      xmlJudgment({
        sufficient: false,
        nextQuery: "我的表达风格",
        narrative: "需要更多了解...",
        reason: "insufficient",
      }),
      xmlJudgment({
        sufficient: true,
        narrative: "现在了解够了",
        reason: "all met",
      }),
    );

    const result = await batchRecall({
      chatClient: client,
      embeddingClient: mockEmbeddingClient(),
      searchAnchors: vi.fn().mockResolvedValue([anchor]),
      goals: ["identity", "question"],
      context: "test",
      visitorKey: "test-visitor",
    });

    expect(result.sufficient).toBe(true);
    expect(result.rounds).toBe(2);
    expect(result.anchors).toContainEqual(anchor);
  });

  it("should stop at maxRounds", async () => {
    const insufficientXml = xmlJudgment({
      sufficient: false,
      nextQuery: "more",
      narrative: "thinking...",
      reason: "need more",
    });

    const client = mockChatClient(insufficientXml, insufficientXml, insufficientXml);

    const result = await batchRecall({
      chatClient: client,
      embeddingClient: mockEmbeddingClient(),
      searchAnchors: vi.fn().mockResolvedValue([]),
      goals: ["g"],
      context: "test",
      visitorKey: "test-visitor",
      maxRounds: 3,
    });

    expect(result.sufficient).toBe(false);
    expect(result.rounds).toBe(3);
  });

  it("should include cachedAnchors in result", async () => {
    const cached: SoulAnchor = {
      id: "cached-1",
      question: "缓存问题",
      answer: "缓存答案",
      source: "interview",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const client = mockChatClient(xmlJudgment({ sufficient: true, reason: "ok" }));

    const result = await batchRecall({
      chatClient: client,
      embeddingClient: mockEmbeddingClient(),
      searchAnchors: vi.fn().mockResolvedValue([]),
      goals: ["g"],
      context: "test",
      visitorKey: "test-visitor",
      cachedAnchors: [cached],
    });

    expect(result.anchors).toContainEqual(cached);
  });
});
