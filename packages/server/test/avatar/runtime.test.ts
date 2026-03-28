import { describe, expect, it, vi, beforeEach } from "vitest";
import { AvatarInferenceRuntime } from "../../src/avatar/runtime.js";
import { goalBasedRecall } from "../../src/recall/goal-based-recall.js";
import { readProfileSummary } from "../../src/routes/profile.js";
import type { ChatClient } from "../../src/llm/client.js";
import type { ConnectionManager } from "../../src/db/connection.js";
import type { ChatResponse } from "../../src/llm/client.js";
import type { SoulAnchor } from "../../src/types.js";

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
  const anchors: SoulAnchor[] = [
    {
      id: "anchor-1",
      question: "沟通边界",
      answer: "先确认约束再给建议",
      source: "interview",
      createdAt: Date.parse("2026-03-26T12:00:00.000Z"),
      updatedAt: Date.parse("2026-03-27T21:13:08.000Z"),
    },
  ];

  return {
    drizzle: {
      select: vi.fn((fields?: unknown) => ({
        from: vi.fn(() => {
          if (fields) {
            return {
              get: vi.fn(() => ({ count: anchorCount })),
            };
          }

          return {
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => ({
                all: vi.fn(() => anchors),
              })),
              all: vi.fn(() => anchors),
            })),
            where: vi.fn(() => ({
              all: vi.fn(() => anchors),
            })),
          };
        }),
      })),
    },
    raw: {},
  } as unknown as OwnerConn;
}

function createChatResponse(content: string): ChatResponse {
  return {
    content,
    finishReason: "stop",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

function createDecompositionResponse(content = "你好"): string {
  return JSON.stringify({
    userQuery: content,
    currentTime: "2026-03-28T12:34:56.000Z",
    answerGoals: [
      { id: "identity_style", goal: "我是谁，我的身份和表达风格", required: true },
      { id: "relationship_boundary", goal: "对方是谁，我与对方的关系和沟通边界", required: true },
      { id: "domain_answer", goal: "回答提问者的问题所需的认知", required: true },
    ],
    successCriteria: ["基于证据回答", "缺失时承认边界"],
  });
}

function createAssessmentResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sufficient: true,
    goalStatus: [
      {
        goalId: "identity_style",
        sufficient: true,
        known: ["知道身份风格"],
        missing: [],
        knownAnchorIds: ["anchor-1"],
        missingKeys: [],
      },
      {
        goalId: "relationship_boundary",
        sufficient: true,
        known: ["知道关系边界"],
        missing: [],
        knownAnchorIds: ["anchor-1"],
        missingKeys: [],
      },
      {
        goalId: "domain_answer",
        sufficient: true,
        known: ["已有回答所需认知"],
        missing: [],
        knownAnchorIds: ["anchor-1"],
        missingKeys: [],
      },
    ],
    nextQuery: "",
    reasoningChain: ["已有锚点足以支撑回答"],
    narrative: "思考中...",
    ...overrides,
  });
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

  it("falls back to default goals when decomposition JSON is invalid", async () => {
    const runtime = new AvatarInferenceRuntime({
      ownerConn: createOwnerConn(0),
      chatClient: createChatClient(),
      embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
    });

    const { goalBasedRecall: actualGoalBasedRecall } = await vi.importActual<
      typeof import("../../src/recall/goal-based-recall.js")
    >("../../src/recall/goal-based-recall.js");
    mockGoalBasedRecall.mockImplementation((options) => actualGoalBasedRecall(options));
    vi.mocked(runtime["deps"].chatClient.chat)
      .mockResolvedValueOnce(createChatResponse("not-json"))
      .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()));

    await runtime.createRequest({
      avatarTarget: { publicKey: "owner-pubkey" },
      conversationTurns: [{ role: "user", content: "你好" }],
      stream: false,
    });

    const assessmentPrompt = vi.mocked(runtime["deps"].chatClient.chat).mock.calls[1]?.[0]
      .messages[1]?.content;
    expect(assessmentPrompt).toContain("identity_style");
    expect(assessmentPrompt).toContain("relationship_boundary");
    expect(assessmentPrompt).toContain("domain_answer");
  });

  it("enforces temporal validity for time-sensitive queries", async () => {
    const runtime = new AvatarInferenceRuntime({
      ownerConn: createOwnerConn(0),
      chatClient: createChatClient(),
      embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
    });

    const { goalBasedRecall: actualGoalBasedRecall } = await vi.importActual<
      typeof import("../../src/recall/goal-based-recall.js")
    >("../../src/recall/goal-based-recall.js");
    mockGoalBasedRecall.mockImplementation((options) => actualGoalBasedRecall(options));
    vi.mocked(runtime["deps"].chatClient.chat)
      .mockResolvedValueOnce(
        createChatResponse(
          JSON.stringify({
            userQuery: "我最近怎么样？",
            currentTime: "2026-03-28T12:34:56.000Z",
            answerGoals: [
              { id: "identity_style", goal: "我是谁，我的身份和表达风格", required: true },
              {
                id: "relationship_boundary",
                goal: "对方是谁，我与对方的关系和沟通边界",
                required: true,
              },
              { id: "domain_answer", goal: "回答提问者的问题所需的认知", required: true },
            ],
            successCriteria: ["基于证据回答"],
          }),
        ),
      )
      .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()));

    await runtime.createRequest({
      avatarTarget: { publicKey: "owner-pubkey" },
      conversationTurns: [{ role: "user", content: "我最近怎么样？" }],
      stream: false,
    });

    const assessmentPrompt = vi.mocked(runtime["deps"].chatClient.chat).mock.calls[1]?.[0]
      .messages[1]?.content;
    expect(assessmentPrompt).toContain("temporal_validity");
  });

  it("summarizes recall gaps naturally and keeps recall tail as final assistant message", async () => {
    const chatClient = createChatClient();
    const runtime = new AvatarInferenceRuntime({
      ownerConn: createOwnerConn(999),
      chatClient,
      embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
    });

    vi.mocked(chatClient.chat).mockResolvedValueOnce(
      createChatResponse(createDecompositionResponse("我最近怎么样？")),
    );
    mockGoalBasedRecall.mockResolvedValue({
      ...createRecallCompatResult(),
      sufficient: false,
      goalStatus: [
        {
          goalId: "identity_style",
          sufficient: true,
          knownAnchorIds: ["anchor-1"],
          missingKeys: [],
          known: ["知道身份风格"],
          missing: [],
        },
        {
          goalId: "relationship_boundary",
          sufficient: true,
          knownAnchorIds: ["anchor-1"],
          missingKeys: [],
          known: ["知道关系边界"],
          missing: [],
        },
        {
          goalId: "domain_answer",
          sufficient: false,
          knownAnchorIds: ["anchor-1"],
          missingKeys: ["recent-position"],
          known: ["已有部分信息"],
          missing: ["缺少更近期更新"],
        },
      ],
      stoppedBecause: "no-new-anchors",
    });

    const request = await runtime.createRequest({
      avatarTarget: { publicKey: "owner-pubkey" },
      conversationTurns: [
        { role: "system", content: "请结合最近聊天回答" },
        { role: "assistant", content: "上次我提到会先确认边界。" },
        { role: "user", content: "我最近怎么样？" },
      ],
      stream: false,
    });

    expect(request.instructionSegments.recall).toContain("缺少更近期更新");
    expect(request.instructionSegments.recall).toContain("没有找到新的可用锚点");
    expect(request.instructionSegments.recall).not.toContain("StoppedBecause");
    expect(request.instructionSegments.recall).not.toContain("recent-position");
    expect(request.instructionSegments.recall).not.toContain("MissingKeys");
    const messages = runtime.buildMessages(request);
    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(messages[1]?.content).toBe("上次我提到会先确认边界。");
    expect(messages[2]?.content).toBe("我最近怎么样？");
    expect(messages[messages.length - 1]?.role).toBe("assistant");
    expect(messages[messages.length - 1]?.content).toBe(request.instructionSegments.recall);
  });

  it("uses natural-language fallback when only missingKeys are available", async () => {
    const runtime = new AvatarInferenceRuntime({
      ownerConn: createOwnerConn(999),
      chatClient: createChatClient(),
      embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
    });

    mockGoalBasedRecall.mockResolvedValue({
      ...createRecallCompatResult(),
      sufficient: false,
      goalStatus: [
        {
          goalId: "domain_answer",
          sufficient: false,
          knownAnchorIds: [],
          missingKeys: ["time-validity-uncertain"],
          known: [],
          missing: [],
        },
      ],
      stoppedBecause: "parse-failure",
    });

    const request = await runtime.createRequest({
      avatarTarget: { publicKey: "owner-pubkey" },
      conversationTurns: [{ role: "user", content: "test" }],
      stream: false,
    });

    expect(request.instructionSegments.recall).toContain("相关信息的时间有效性还不够确定");
    expect(request.instructionSegments.recall).toContain("本轮充分性判断未能稳定完成");
    expect(request.instructionSegments.recall).not.toContain("time-validity-uncertain");
    expect(request.instructionSegments.recall).not.toContain("parse-failure");
  });

  it("does not leak reasoning chain when judgment parsing fails", async () => {
    const runtime = new AvatarInferenceRuntime({
      ownerConn: createOwnerConn(0),
      chatClient: createChatClient(),
      embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
    });

    const { goalBasedRecall: actualGoalBasedRecall } = await vi.importActual<
      typeof import("../../src/recall/goal-based-recall.js")
    >("../../src/recall/goal-based-recall.js");
    mockGoalBasedRecall.mockImplementation((options) => actualGoalBasedRecall(options));
    vi.mocked(runtime["deps"].chatClient.chat)
      .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("test")))
      .mockResolvedValueOnce(
        createChatResponse(
          JSON.stringify({
            sufficient: "false",
            goalStatus: [],
            nextQuery: "继续找",
            reasoningChain: ["这条链路不该泄漏"],
            narrative: "思考中...",
          }),
        ),
      )
      .mockResolvedValueOnce(
        createChatResponse(
          JSON.stringify({
            sufficient: "false",
            goalStatus: [],
            nextQuery: "继续找",
            reasoningChain: ["这条链路也不该泄漏"],
            narrative: "思考中...",
          }),
        ),
      );

    const request = await runtime.createRequest({
      avatarTarget: { publicKey: "owner-pubkey" },
      conversationTurns: [{ role: "user", content: "test" }],
      stream: false,
    });

    expect(request.instructionSegments.recall).toContain("本轮充分性判断未能稳定完成");
    expect(request.instructionSegments.recall).not.toContain("这条链路不该泄漏");
    expect(request.instructionSegments.recall).not.toContain("这条链路也不该泄漏");
  });
});
