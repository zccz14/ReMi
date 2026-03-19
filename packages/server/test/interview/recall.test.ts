import { describe, it, expect, vi } from "vitest";
import { agenticRecall } from "../../src/interview/recall.js";
import type { ChatClient } from "../../src/llm/client.js";
import type { SoulAnchor } from "../../src/types.js";

function xmlJudgment(opts: {
  sufficient: boolean;
  nextQuery?: string;
  reason: string;
  narrative?: string;
}): string {
  return `<judgment>
<sufficient>${opts.sufficient}</sufficient>
<next_query>${opts.nextQuery ?? ""}</next_query>
<reason>${opts.reason}</reason>
<narrative>${opts.narrative ?? ""}</narrative>
</judgment>`;
}

function mockChatClient(responses: string[]): ChatClient {
  const chatFn = vi.fn();
  for (const r of responses) {
    chatFn.mockResolvedValueOnce({
      content: r,
      finishReason: "stop",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
  }
  return { chat: chatFn, chatStream: vi.fn() };
}

function mockEmbeddingClient(embeddings: number[][]) {
  return { embed: vi.fn().mockResolvedValue(embeddings) };
}

describe("agenticRecall", () => {
  it("should return immediately if sufficient on first round", async () => {
    const client = mockChatClient([
      xmlJudgment({ sufficient: true, reason: "enough", narrative: "我已经了解够了" }),
    ]);
    const narratives: string[] = [];
    const result = await agenticRecall({
      chatClient: client,
      embeddingClient: mockEmbeddingClient([[0.1, 0.2]]),
      searchAnchors: async () => [],
      context: "test context",
      goal: "test goal",
      maxRounds: 5,
      topK: 10,
      onNarrative: (n) => narratives.push(n),
    });
    expect(result.sufficient).toBe(true);
    expect(result.rounds).toBe(1);
    expect(narratives).toEqual(["我已经了解够了"]);
  });

  it("should loop until sufficient", async () => {
    const anchor: SoulAnchor = {
      id: "1",
      question: "价值观",
      answer: "诚实",
      source: "interview",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const client = mockChatClient([
      xmlJudgment({
        sufficient: false,
        nextQuery: "价值观",
        reason: "need more",
        narrative: "让我再想想...",
      }),
      xmlJudgment({ sufficient: true, reason: "ok now", narrative: "现在够了" }),
    ]);
    const result = await agenticRecall({
      chatClient: client,
      embeddingClient: mockEmbeddingClient([
        [0.1, 0.2],
        [0.3, 0.4],
      ]),
      searchAnchors: async () => [anchor],
      context: "test",
      goal: "test",
      maxRounds: 5,
      topK: 10,
    });
    expect(result.sufficient).toBe(true);
    expect(result.rounds).toBe(2);
    expect(result.anchors).toContainEqual(anchor);
  });

  it("should stop at maxRounds", async () => {
    const client = mockChatClient([
      xmlJudgment({ sufficient: false, nextQuery: "q1", reason: "r", narrative: "n1" }),
      xmlJudgment({ sufficient: false, nextQuery: "q2", reason: "r", narrative: "n2" }),
      xmlJudgment({ sufficient: false, nextQuery: "q3", reason: "r", narrative: "n3" }),
    ]);
    const result = await agenticRecall({
      chatClient: client,
      embeddingClient: mockEmbeddingClient([[0.1], [0.2], [0.3]]),
      searchAnchors: async () => [],
      context: "test",
      goal: "test",
      maxRounds: 3,
      topK: 10,
    });
    expect(result.sufficient).toBe(false);
    expect(result.rounds).toBe(3);
  });
});
