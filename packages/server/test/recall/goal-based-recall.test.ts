import { describe, expect, it, vi } from "vitest";
import { goalBasedRecall } from "../../src/recall/goal-based-recall.js";
import {
  RECALL_FULL_INJECTION_THRESHOLD,
  RECALL_MISSING_KEYS,
  RECALL_STOP_REASONS,
} from "../../src/recall/constants.js";
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

function createGoalStatus(overrides: Record<string, unknown> = {}) {
  return {
    goalId: "domain_answer",
    sufficient: true,
    knownAnchorIds: ["a2"],
    missingKeys: [],
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
    expect(options.chatClient.chat).toHaveBeenCalledTimes(1);
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

  it("returns normalized metadata for full injection", async () => {
    const anchor = createAnchor("a1", "问题1");
    const options = createOptions({
      goals: ["identity_style", "domain_answer"],
      countAnchors: vi.fn().mockResolvedValue(RECALL_FULL_INJECTION_THRESHOLD),
      listAnchors: vi.fn().mockResolvedValue([anchor]),
      parseJudgment: vi.fn().mockReturnValue({
        sufficient: true,
        goalStatus: [
          createGoalStatus({
            goalId: "identity_style",
            sufficient: true,
            knownAnchorIds: ["a1"],
            missingKeys: [],
          }),
          createGoalStatus({
            goalId: "domain_answer",
            sufficient: false,
            knownAnchorIds: ["a1"],
            missingKeys: ["domain-fact-missing"],
          }),
        ],
      }),
    });

    const result = await goalBasedRecall(options as never);

    expect(result).toEqual(
      expect.objectContaining({
        strategy: "full-injection",
        rounds: 0,
        sufficient: false,
        stoppedBecause: RECALL_STOP_REASONS.NO_NEW_ANCHORS,
        goalStatus: expect.any(Array),
        roundSummaries: [],
      }),
    );
    expect(result.goalStatus).toEqual([
      expect.objectContaining({
        goalId: "identity_style",
        sufficient: true,
        knownAnchorIds: ["a1"],
        missingKeys: [],
      }),
      expect.objectContaining({
        goalId: "domain_answer",
        sufficient: false,
        knownAnchorIds: ["a1"],
        missingKeys: ["domain-fact-missing"],
      }),
    ]);
    expect(options.chatClient.chat).toHaveBeenCalledTimes(1);
    expect(options.parseJudgment).toHaveBeenCalledTimes(1);
    expect(options.buildJudgmentPrompt).toHaveBeenCalledWith({
      goals: ["identity_style", "domain_answer"],
      anchors: [anchor],
      context: "user: hello",
    });
  });

  it("treats invalid parsed nextQuery shape as parse-failure", async () => {
    const options = createOptions({
      parseJudgment: vi.fn().mockReturnValue({
        sufficient: false,
        nextQuery: 123,
        goalStatus: [createGoalStatus({ sufficient: false, missingKeys: ["domain-fact-missing"] })],
      }),
    });

    const result = await goalBasedRecall(options as never);

    expect(result.stoppedBecause).toBe(RECALL_STOP_REASONS.PARSE_FAILURE);
    expect(result.sufficient).toBe(false);
  });

  it("treats invalid goalStatus arrays as parse-failure", async () => {
    const options = createOptions({
      parseJudgment: vi.fn().mockReturnValue({
        sufficient: false,
        nextQuery: "继续问",
        goalStatus: [{ goalId: "domain_answer", sufficient: false, missingKeys: "bad-shape" }],
      }),
    });

    const result = await goalBasedRecall(options as never);

    expect(result.stoppedBecause).toBe(RECALL_STOP_REASONS.PARSE_FAILURE);
  });

  it("drops unknown goal ids and backfills required goals deterministically", async () => {
    const options = createOptions({
      goals: ["domain_answer"],
      parseJudgment: vi.fn().mockReturnValue({
        sufficient: false,
        nextQuery: "继续问",
        goalStatus: [createGoalStatus({ goalId: "invented_goal", missingKeys: [] })],
      }),
    });

    const result = await goalBasedRecall(options as never);

    expect(result.goalStatus).toEqual([
      expect.objectContaining({
        goalId: "domain_answer",
        sufficient: false,
        missingKeys: ["unassessed-required-goal"],
      }),
    ]);
  });

  it("uses the last duplicate goal entry when goal ids repeat", async () => {
    const options = createOptions({
      goals: ["domain_answer"],
      parseJudgment: vi.fn().mockReturnValue({
        sufficient: false,
        nextQuery: "继续问",
        goalStatus: [
          createGoalStatus({ sufficient: false, missingKeys: ["domain-fact-missing"] }),
          createGoalStatus({ sufficient: true, missingKeys: [] }),
        ],
      }),
    });

    const result = await goalBasedRecall(options as never);

    expect(result.goalStatus).toEqual([
      expect.objectContaining({
        goalId: "domain_answer",
        sufficient: true,
        missingKeys: [],
      }),
    ]);
  });

  it("computes overall sufficient from required goal status instead of trusting the model", async () => {
    const options = createOptions({
      parseJudgment: vi.fn().mockReturnValue({
        sufficient: true,
        goalStatus: [
          createGoalStatus({
            goalId: "identity_style",
            sufficient: true,
            missingKeys: [],
          }),
          createGoalStatus({
            goalId: "relationship_boundary",
            sufficient: true,
            missingKeys: [],
          }),
          createGoalStatus({
            goalId: "domain_answer",
            sufficient: true,
            missingKeys: ["domain-fact-missing"],
          }),
        ],
      }),
    });

    const result = await goalBasedRecall(options as never);

    expect(result.sufficient).toBe(false);
  });

  it("backfills omitted required goals as unassessed-required-goal", async () => {
    const options = createOptions({
      goals: ["identity_style", "relationship_boundary", "domain_answer"],
      parseJudgment: vi.fn().mockReturnValue({
        sufficient: false,
        goalStatus: [createGoalStatus({ goalId: "identity_style", missingKeys: [] })],
      }),
    });

    const result = await goalBasedRecall(options as never);

    expect(result.goalStatus).toContainEqual(
      expect.objectContaining({
        goalId: "domain_answer",
        sufficient: false,
        missingKeys: ["unassessed-required-goal"],
      }),
    );
  });

  it("normalizes unknown missing keys to other", async () => {
    const options = createOptions({
      goals: ["domain_answer"],
      maxRounds: 2,
      searchAnchors: vi
        .fn()
        .mockResolvedValueOnce([createAnchor("a2", "问题2")])
        .mockResolvedValueOnce([createAnchor("a3", "问题3")]),
      parseJudgment: vi
        .fn()
        .mockReturnValueOnce({
          sufficient: false,
          nextQuery: "继续问",
          goalStatus: [
            createGoalStatus({
              goalId: "domain_answer",
              sufficient: false,
              missingKeys: ["brand-new-unknown-key"],
            }),
          ],
        })
        .mockReturnValueOnce({
          sufficient: false,
          nextQuery: "还要继续问",
          goalStatus: [
            createGoalStatus({
              goalId: "domain_answer",
              sufficient: false,
              missingKeys: ["another-unknown-key"],
            }),
          ],
        }),
    });

    const result = await goalBasedRecall(options as never);

    expect(result.goalStatus).toContainEqual(
      expect.objectContaining({
        goalId: "domain_answer",
        missingKeys: ["other"],
      }),
    );
    expect(result.stoppedBecause).toBe(RECALL_STOP_REASONS.NO_MISSING_REDUCED);
  });

  it("stops early when a round adds no new anchors", async () => {
    const options = createOptions({
      parseJudgment: vi.fn().mockReturnValue({
        sufficient: false,
        nextQuery: "继续问",
        goalStatus: [createGoalStatus({ sufficient: false, missingKeys: ["domain-fact-missing"] })],
      }),
      searchAnchors: vi.fn().mockResolvedValue([]),
    });

    const result = await goalBasedRecall(options as never);

    expect(result.stoppedBecause).toBe(RECALL_STOP_REASONS.NO_NEW_ANCHORS);
    expect(result.rounds).toBe(1);
  });

  it("stops early when normalized missing keys do not reduce across rounds", async () => {
    const options = createOptions({
      maxRounds: 3,
      searchAnchors: vi
        .fn()
        .mockResolvedValueOnce([createAnchor("a2", "问题2")])
        .mockResolvedValueOnce([createAnchor("a3", "问题3")]),
      parseJudgment: vi
        .fn()
        .mockReturnValueOnce({
          sufficient: false,
          nextQuery: "第二轮",
          goalStatus: [createGoalStatus({ sufficient: false, missingKeys: ["recent-position"] })],
        })
        .mockReturnValueOnce({
          sufficient: false,
          nextQuery: "第三轮",
          goalStatus: [createGoalStatus({ sufficient: false, missingKeys: ["recent-position"] })],
        }),
    });

    const result = await goalBasedRecall(options as never);

    expect(result.stoppedBecause).toBe(RECALL_STOP_REASONS.NO_MISSING_REDUCED);
  });

  it("retries one parse failure before succeeding", async () => {
    const options = createOptions({
      goals: ["domain_answer"],
      parseJudgment: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("bad parse");
        })
        .mockReturnValueOnce({
          sufficient: true,
          goalStatus: [createGoalStatus()],
        }),
    });

    const result = await goalBasedRecall(options as never);

    expect(result.sufficient).toBe(true);
    expect(options.parseJudgment).toHaveBeenCalledTimes(2);
  });

  it("stops with parse-failure after the retry also fails", async () => {
    const options = createOptions({
      parseJudgment: vi.fn().mockImplementation(() => {
        throw new Error("bad parse");
      }),
    });

    const result = await goalBasedRecall(options as never);

    expect(result.stoppedBecause).toBe(RECALL_STOP_REASONS.PARSE_FAILURE);
    expect(result.sufficient).toBe(false);
    expect(options.parseJudgment).toHaveBeenCalledTimes(2);
  });

  it.each(["", "   ", "user: hello", "  user: hello  "])(
    "stops with empty-next-query for %j",
    async (nextQuery) => {
      const options = createOptions({
        parseJudgment: vi.fn().mockReturnValue({
          sufficient: false,
          nextQuery,
          goalStatus: [
            createGoalStatus({ sufficient: false, missingKeys: ["domain-fact-missing"] }),
          ],
        }),
      });

      const result = await goalBasedRecall(options as never);

      expect(result.stoppedBecause).toBe(RECALL_STOP_REASONS.EMPTY_NEXT_QUERY);
    },
  );

  it("records round summaries with normalized goal status", async () => {
    const options = createOptions({
      goals: ["domain_answer"],
      parseJudgment: vi.fn().mockReturnValue({
        sufficient: false,
        nextQuery: "user: hello",
        goalStatus: [
          createGoalStatus({
            sufficient: false,
            missingKeys: [RECALL_MISSING_KEYS[0], "unknown-key"],
          }),
        ],
      }),
    });

    const result = await goalBasedRecall(options as never);

    expect(result.roundSummaries).toEqual([
      expect.objectContaining({
        round: 1,
        query: "user: hello",
        newAnchorIds: ["a2"],
        allAnchorIds: ["a2"],
        normalizedGoalStatus: [
          expect.objectContaining({
            goalId: "domain_answer",
            missingKeys: [RECALL_MISSING_KEYS[0], "other"],
          }),
        ],
        stoppedCandidate: RECALL_STOP_REASONS.EMPTY_NEXT_QUERY,
      }),
    ]);
  });
});
