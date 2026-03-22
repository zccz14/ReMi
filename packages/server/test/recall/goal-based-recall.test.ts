import { describe, expect, it, vi } from "vitest";
import { goalBasedRecall } from "../../src/recall/goal-based-recall.js";
import { RECALL_FULL_INJECTION_THRESHOLD } from "../../src/recall/constants.js";
import type { SoulAnchor } from "../../src/types.js";

function createAnchor(id: string, question: string, updatedAt = Date.now()): SoulAnchor {
  return {
    id,
    question,
    answer: `${question} 的答案`,
    source: "interview",
    createdAt: updatedAt,
    updatedAt,
  };
}

function createOptions(overrides: Record<string, unknown> = {}) {
  const a1 = createAnchor("a1", "问题1", 2);
  const a2 = createAnchor("a2", "问题2", 1);
  return {
    chatClient: {
      chat: vi.fn().mockResolvedValue({
        content:
          "<judgment><sufficient>true</sufficient><next_query></next_query><narrative>done</narrative></judgment>",
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
      chatStream: vi.fn(),
    },
    embeddingClient: {
      embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
    },
    goals: ["理解当前话题"],
    context: "user: hello",
    initialAnchors: [] as SoulAnchor[],
    countAnchors: vi.fn().mockResolvedValue(RECALL_FULL_INJECTION_THRESHOLD + 1),
    listAnchors: vi.fn().mockResolvedValue([a1, a2]),
    searchAnchors: vi.fn().mockResolvedValue([a2]),
    buildJudgmentPrompt: vi.fn().mockReturnValue([{ role: "user", content: "judge" }]),
    parseJudgment: vi.fn().mockReturnValue({ sufficient: true, narrative: "done" }),
    onNarrative: vi.fn(),
    ...overrides,
  };
}

describe("goalBasedRecall", () => {
  it("returns all anchors via full injection when count is at or below threshold", async () => {
    const options = createOptions({
      countAnchors: vi.fn().mockResolvedValue(RECALL_FULL_INJECTION_THRESHOLD),
    });

    const result = await goalBasedRecall(options as never);

    expect(result.strategy).toBe("full-injection");
    expect(result.anchors.map((anchor) => anchor.id)).toEqual(["a1", "a2"]);
    expect(options.embeddingClient.embed).not.toHaveBeenCalled();
    expect(options.chatClient.chat).not.toHaveBeenCalled();
  });

  it("enters recall loop when anchor count exceeds threshold", async () => {
    const options = createOptions();

    const result = await goalBasedRecall(options as never);

    expect(result.strategy).toBe("recall-loop");
    expect(options.embeddingClient.embed).toHaveBeenCalled();
    expect(options.chatClient.chat).toHaveBeenCalled();
  });

  it("uses initial anchors as the starting working set", async () => {
    const a1 = createAnchor("a1", "问题1");
    const a2 = createAnchor("a2", "问题2");
    const options = createOptions({
      initialAnchors: [a1],
      searchAnchors: vi.fn().mockResolvedValue([a2]),
    });

    const result = await goalBasedRecall(options as never);

    expect(result.anchors).toEqual([a1, a2]);
  });

  it("throws a clear error when recall loop lacks embedding client", async () => {
    const options = createOptions({ embeddingClient: undefined });

    await expect(goalBasedRecall(options as never)).rejects.toThrow(
      "Embedding client not configured for recall loop",
    );
  });

  it("preserves stable ordering from full injection listAnchors", async () => {
    const a2 = createAnchor("a2", "问题2", 10);
    const a1 = createAnchor("a1", "问题1", 5);
    const options = createOptions({
      countAnchors: vi.fn().mockResolvedValue(RECALL_FULL_INJECTION_THRESHOLD),
      listAnchors: vi.fn().mockResolvedValue([a2, a1]),
    });

    const result = await goalBasedRecall(options as never);

    expect(result.anchors.map((anchor) => anchor.id)).toEqual(["a2", "a1"]);
  });
});
