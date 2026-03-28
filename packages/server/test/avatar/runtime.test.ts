import { describe, expect, it, vi, beforeEach } from "vitest";
import { AvatarInferenceRuntime } from "../../src/avatar/runtime.js";
import { goalBasedRecall } from "../../src/recall/goal-based-recall.js";
import { readProfileSummary } from "../../src/routes/profile.js";
import type { ChatClient } from "../../src/llm/client.js";
import type { ConnectionManager } from "../../src/db/connection.js";

vi.mock("../../src/recall/goal-based-recall.js", () => ({
  goalBasedRecall: vi.fn(),
}));

vi.mock("../../src/routes/profile.js", () => ({
  readProfileSummary: vi.fn(),
}));

const mockGoalBasedRecall = vi.mocked(goalBasedRecall);
const mockReadProfileSummary = vi.mocked(readProfileSummary);
type OwnerConn = ReturnType<ConnectionManager["getConnection"]>;
type GoalBasedRecallCompatResult = Awaited<ReturnType<typeof goalBasedRecall>> & {
  goalStatus: {
    goalId: string;
    sufficient: boolean;
    knownAnchorIds: string[];
    missingKeys: string[];
  }[];
  stoppedBecause: string;
  roundSummaries: {
    round: number;
    query: string;
    newAnchorIds: string[];
    allAnchorIds: string[];
    normalizedGoalStatus: unknown[];
  }[];
} & {
  debug: { traceId: string; nested: { shouldNotLeak: string } };
  metadata: { ignored: string[]; flags: { experimental: boolean } };
  unexpected: { deeply: { nested: { object: string } } };
  __experimental: string;
};

function createRecallCompatResult(): GoalBasedRecallCompatResult {
  return {
    anchors: [
      {
        id: "anchor-1",
        question: "沟通边界",
        answer: "先确认约束再给建议",
        source: "interview",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    narratives: ["已命中边界锚点"],
    rounds: 1,
    sufficient: true,
    strategy: "recall-loop",
    goalStatus: [
      {
        goalId: "boundary",
        sufficient: true,
        knownAnchorIds: ["anchor-1"],
        missingKeys: [],
      },
    ],
    stoppedBecause: "sufficient",
    roundSummaries: [
      {
        round: 1,
        query: "沟通边界",
        newAnchorIds: ["anchor-1"],
        allAnchorIds: ["anchor-1"],
        normalizedGoalStatus: [],
      },
    ],
    debug: {
      traceId: "debug-trace-token",
      nested: { shouldNotLeak: "debug-nested-value" },
    },
    metadata: {
      ignored: ["metadata-flag"],
      flags: { experimental: true },
    },
    unexpected: {
      deeply: { nested: { object: "totally-irrelevant-object" } },
    },
    __experimental: "unknown-top-level-field",
  };
}

function createOwnerConn(anchorCount: number): OwnerConn {
  return {
    drizzle: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          get: vi.fn(() => ({ count: anchorCount })),
        })),
      })),
    },
    raw: {},
  } as unknown as OwnerConn;
}

function createChatClient(): ChatClient {
  return {
    chat: vi.fn(),
    chatStream: vi.fn(),
  };
}

describe("AvatarInferenceRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadProfileSummary.mockReturnValue({
      displayName: "ReMi",
      bio: "保持上下文一致",
      hasAvatar: false,
      avatarVersion: null,
      updatedAt: null,
    });
    mockGoalBasedRecall.mockResolvedValue(createRecallCompatResult());
  });

  it("createRequest tolerates extra recall fields and keeps anchors in recall segment", async () => {
    const runtime = new AvatarInferenceRuntime({
      ownerConn: createOwnerConn(999),
      chatClient: createChatClient(),
      embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
    });

    const request = await runtime.createRequest({
      avatarTarget: { publicKey: "owner-pubkey" },
      conversationTurns: [{ role: "user", content: "帮我做个计划" }],
      stream: false,
    });

    expect(mockGoalBasedRecall).toHaveBeenCalledTimes(1);
    expect(request.instructionSegments.recall).toContain("Supplementary recalled anchors");
    expect(request.instructionSegments.recall).toContain("Q: 沟通边界");
    expect(request.instructionSegments.recall).toContain("A: 先确认约束再给建议");
    expect(request.instructionSegments.recall).not.toContain("debug-trace-token");
    expect(request.instructionSegments.recall).not.toContain("debug-nested-value");
    expect(request.instructionSegments.recall).not.toContain("metadata-flag");
    expect(request.instructionSegments.recall).not.toContain("totally-irrelevant-object");
    expect(request.instructionSegments.recall).not.toContain("unknown-top-level-field");
    expect(request.instructionSegments.recall).not.toContain("stoppedBecause");
    expect(request.instructionSegments.recall).not.toContain("goalStatus");
    expect(request.instructionSegments.avatar).toContain("display name: ReMi");
  });
});
