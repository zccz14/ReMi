import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AvatarInferenceRuntime } from "../../src/avatar/runtime.js";
import type { AvatarInferenceRequest } from "../../src/avatar/model.js";
import { goalBasedRecall } from "../../src/recall/goal-based-recall.js";
import { readProfileSummary } from "../../src/routes/profile.js";
import type { ChatClient } from "../../src/llm/client.js";
import type { ConnectionManager } from "../../src/db/connection.js";
import type { ChatResponse } from "../../src/llm/client.js";
import { createLatestReasoningDebugArtifactWriter } from "../../src/reasoning/debug-artifact.js";
import * as reasoningGapProbes from "../../src/reasoning/gap-probes.js";
import type { SoulAnchor } from "../../src/types.js";
import { createAbortError } from "../../src/lib/abort.js";

vi.mock("../../src/recall/goal-based-recall.js", () => ({
  goalBasedRecall: vi.fn(),
}));

vi.mock("../../src/routes/profile.js", () => ({
  readProfileSummary: vi.fn(),
}));

const mockGoalBasedRecall = vi.mocked(goalBasedRecall);
const mockReadProfileSummary = vi.mocked(readProfileSummary);
const defaultProbeStats = { rawDraftCount: 1, droppedCount: 0 };
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
        createdAt: Date.parse("2026-03-26T12:00:00.000Z"),
        updatedAt: Date.parse("2026-03-27T21:13:08.000Z"),
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
    raw: {
      prepare: vi.fn(() => ({
        all: vi.fn(() => anchors.map((anchor) => ({ id: anchor.id, distance: 0.1 }))),
      })),
    },
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

function createBuildMessagesRequest(
  conversationTurns: AvatarInferenceRequest["conversationTurns"],
): AvatarInferenceRequest {
  return {
    avatarTarget: { publicKey: "owner-pubkey" },
    instructionSegments: {
      platform: "platform",
      avatar: "avatar",
      recall: "recall tail",
    },
    conversationTurns,
    contentParts: [],
    stream: false,
  };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
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

  it("keeps a mid-conversation system turn in place for user system assistant ordering", () => {
    const runtime = new AvatarInferenceRuntime({
      ownerConn: createOwnerConn(0),
      chatClient: createChatClient(),
      embeddingClient: null,
    });

    const messages = runtime.buildMessages(
      createBuildMessagesRequest([
        { role: "user", content: "first user" },
        { role: "system", content: "late system" },
        { role: "assistant", content: "assistant reply" },
      ]),
    );

    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "system",
      "assistant",
      "assistant",
    ]);
    expect(messages[1]?.content).toBe("first user");
    expect(messages[2]?.content).toBe("late system");
    expect(messages[3]?.content).toBe("assistant reply");
    expect(messages[4]?.content).toBe("recall tail");
  });

  it("only folds leading contiguous system turns and preserves later system positions", () => {
    const runtime = new AvatarInferenceRuntime({
      ownerConn: createOwnerConn(0),
      chatClient: createChatClient(),
      embeddingClient: null,
    });

    const messages = runtime.buildMessages(
      createBuildMessagesRequest([
        { role: "system", content: "caller system 1" },
        { role: "system", content: "caller system 2" },
        { role: "user", content: "first user" },
        { role: "system", content: "late system 3" },
        { role: "assistant", content: "assistant reply" },
        { role: "system", content: "late system 4" },
      ]),
    );

    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "system",
      "assistant",
      "system",
      "assistant",
    ]);
    expect(messages[0]?.content).toContain("caller system 1");
    expect(messages[0]?.content).toContain("caller system 2");
    expect(messages[0]?.content).not.toContain("late system 3");
    expect(messages[0]?.content).not.toContain("late system 4");
    expect(messages[2]?.content).toBe("late system 3");
    expect(messages[4]?.content).toBe("late system 4");
    expect(messages[5]?.content).toBe("recall tail");
  });

  it("keeps recall as final assistant message when there is no caller system message", () => {
    const runtime = new AvatarInferenceRuntime({
      ownerConn: createOwnerConn(0),
      chatClient: createChatClient(),
      embeddingClient: null,
    });

    const messages = runtime.buildMessages(
      createBuildMessagesRequest([
        { role: "user", content: "first user" },
        { role: "assistant", content: "assistant reply" },
      ]),
    );

    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "assistant",
    ]);
    expect(messages[0]?.content).not.toContain("Caller system supplement");
    expect(messages[3]?.content).toBe("recall tail");
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

  it("rethrows aborts during decomposition instead of falling back", async () => {
    const runtime = new AvatarInferenceRuntime({
      ownerConn: createOwnerConn(0),
      chatClient: createChatClient(),
      embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
    });
    const abortError = createAbortError("decomposition aborted");

    vi.mocked(runtime["deps"].chatClient.chat).mockRejectedValueOnce(abortError);

    await expect(
      runtime.createRequest({
        avatarTarget: { publicKey: "owner-pubkey" },
        conversationTurns: [{ role: "user", content: "你好" }],
        stream: false,
      }),
    ).rejects.toBe(abortError);
    expect(mockGoalBasedRecall).not.toHaveBeenCalled();
  });

  it("falls back to default goals when decomposition JSON misses required goals", async () => {
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
            userQuery: "被模型改写的问题",
            currentTime: "1999-01-01T00:00:00.000Z",
            answerGoals: [{ id: "domain_answer", goal: "只回答问题", required: true }],
            successCriteria: ["..."],
          }),
        ),
      )
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
    expect(request.instructionSegments.recall).toContain("## Evidence");
    expect(request.instructionSegments.recall).toContain("UpdatedAt: 2026-03-27T21:13:08.000Z");
    expect(request.instructionSegments.recall).toContain("## Missing Information");
    expect(request.instructionSegments.recall).toContain("## Non-evidence Reasoning");
    expect(request.instructionSegments.recall).toContain("GoalId: domain_answer");
    expect(request.instructionSegments.recall).toContain("Boundary: 没有找到新的可用锚点。");
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
    expect(request.instructionSegments.recall).toContain("GoalId: domain_answer");
    expect(request.instructionSegments.recall).toContain("Boundary: 本轮充分性判断未能稳定完成。");
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

  it("keeps runtime-owned user query and current time when decomposition response rewrites them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-28T12:34:56.000Z"));

    try {
      const chatClient = createChatClient();
      const { goalBasedRecall: actualGoalBasedRecall } = await vi.importActual<
        typeof import("../../src/recall/goal-based-recall.js")
      >("../../src/recall/goal-based-recall.js");
      mockGoalBasedRecall.mockImplementation((options) => actualGoalBasedRecall(options));
      vi.mocked(chatClient.chat)
        .mockResolvedValueOnce(
          createChatResponse(
            JSON.stringify({
              userQuery: "被模型改写的问题",
              currentTime: "1999-01-01T00:00:00.000Z",
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
        .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()))
        .mockResolvedValueOnce(createChatResponse("最终回答"));

      const runtime = new AvatarInferenceRuntime({
        ownerConn: createOwnerConn(999),
        chatClient,
        embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
      });

      const request = await runtime.createRequest({
        avatarTarget: { publicKey: "owner-pubkey" },
        conversationTurns: [{ role: "user", content: "真实用户问题" }],
        stream: false,
      });
      await runtime.run(request);

      const decompositionPrompt = vi.mocked(chatClient.chat).mock.calls[0]?.[0].messages[1]
        ?.content;
      const finalMessages = vi.mocked(chatClient.chat).mock.calls[
        vi.mocked(chatClient.chat).mock.calls.length - 1
      ]?.[0].messages;
      expect(decompositionPrompt).toContain("2026-03-28T12:34:56.000Z");
      expect(decompositionPrompt).not.toContain("1999-01-01T00:00:00.000Z");
      expect(decompositionPrompt).toContain("真实用户问题");
      expect(decompositionPrompt).not.toContain("被模型改写的问题");
      expect(finalMessages?.[1]?.content).toBe("真实用户问题");
      expect(finalMessages?.[1]?.content).not.toContain("被模型改写的问题");
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows full-injection runtime inference without embedding client", async () => {
    const chatClient = createChatClient();
    vi.mocked(chatClient.chat)
      .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("你好")))
      .mockResolvedValueOnce(createChatResponse("你好，我是分身"));

    const runtime = new AvatarInferenceRuntime({
      ownerConn: createOwnerConn(0),
      chatClient,
      embeddingClient: null,
    });

    const request = await runtime.createRequest({
      avatarTarget: { publicKey: "owner-pubkey" },
      conversationTurns: [{ role: "user", content: "你好" }],
      stream: false,
    });
    const response = await runtime.run(request);

    expect(response.message.content).toBe("你好，我是分身");
    expect(vi.mocked(chatClient.chat)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(chatClient.chatStream)).not.toHaveBeenCalled();
  });

  it("writes turn-based runtime debug artifacts for decomposition sufficiency and final generation", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "remi-runtime-artifact-"));

    try {
      const chatClient = createChatClient();
      const { goalBasedRecall: actualGoalBasedRecall } = await vi.importActual<
        typeof import("../../src/recall/goal-based-recall.js")
      >("../../src/recall/goal-based-recall.js");
      mockGoalBasedRecall.mockImplementation((options) => actualGoalBasedRecall(options));
      const runtime = new AvatarInferenceRuntime({
        ownerConn: createOwnerConn(999),
        chatClient,
        embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
        debugArtifactWriter: createLatestReasoningDebugArtifactWriter({ rootDir: tempRoot }),
      } as ConstructorParameters<typeof AvatarInferenceRuntime>[0]);

      vi.mocked(chatClient.chat)
        .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("我最近怎么样？")))
        .mockResolvedValueOnce(
          createChatResponse(
            createAssessmentResponse({
              sufficient: false,
              goalStatus: [
                {
                  goalId: "domain_answer",
                  sufficient: false,
                  known: ["已有部分信息"],
                  missing: ["缺少更近期更新"],
                  knownAnchorIds: ["anchor-1"],
                  missingKeys: ["recent-position"],
                },
              ],
              nextQuery: "补充查询",
            }),
          ),
        )
        .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()))
        .mockResolvedValueOnce(createChatResponse("你好，我是分身"));

      const request = await runtime.createRequest({
        avatarTarget: { publicKey: "owner-pubkey" },
        conversationTurns: [{ role: "user", content: "我最近怎么样？" }],
        stream: false,
      });
      await runtime.run(request);

      const latestDir = join(tempRoot, "debug", "reasoning-last");
      expect((await lstat(latestDir)).isSymbolicLink()).toBe(true);
      expect((await readdir(latestDir)).sort()).toEqual([
        "01-decomposition-prompt.json",
        "01-decomposition-prompt.md",
        "01-decomposition-response.json",
        "01-decomposition-response.txt",
        "02-sufficiency-round-1-prompt.json",
        "02-sufficiency-round-1-prompt.md",
        "02-sufficiency-round-1-response.json",
        "02-sufficiency-round-1-response.txt",
        "02-sufficiency-round-2-prompt.json",
        "02-sufficiency-round-2-prompt.md",
        "02-sufficiency-round-2-response.json",
        "02-sufficiency-round-2-response.txt",
        "03-final-generation-prompt.json",
        "03-final-generation-prompt.md",
        "03-final-generation-response.txt",
        "final-messages.json",
        "final-prompt.md",
        "recall-rounds.json",
        "response.txt",
        "summary.json",
      ]);
      expect(await readFile(join(latestDir, "03-final-generation-prompt.md"), "utf8")).toContain(
        "[role: system]",
      );
      expect(await readFile(join(latestDir, "final-prompt.md"), "utf8")).toContain("[role: user]");
      expect(await readFile(join(latestDir, "03-final-generation-response.txt"), "utf8")).toBe(
        "你好，我是分身",
      );
      expect(await readJson(join(latestDir, "final-messages.json"))).toEqual(
        runtime.buildMessages(request),
      );
      expect(await readJson(join(latestDir, "summary.json"))).toEqual(
        expect.objectContaining({
          userQuery: "我最近怎么样？",
          rounds: 2,
        }),
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps successful non-stream inference even when runtime artifact write fails", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "remi-runtime-artifact-"));

    try {
      const { goalBasedRecall: actualGoalBasedRecall } = await vi.importActual<
        typeof import("../../src/recall/goal-based-recall.js")
      >("../../src/recall/goal-based-recall.js");
      mockGoalBasedRecall.mockImplementation((options) => actualGoalBasedRecall(options));
      const stableClient = createChatClient();
      vi.mocked(stableClient.chat)
        .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("第一次问题")))
        .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()))
        .mockResolvedValueOnce(createChatResponse("第一次回答"));
      const stableRuntime = new AvatarInferenceRuntime({
        ownerConn: createOwnerConn(999),
        chatClient: stableClient,
        embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
        debugArtifactWriter: createLatestReasoningDebugArtifactWriter({ rootDir: tempRoot }),
      } as ConstructorParameters<typeof AvatarInferenceRuntime>[0]);

      const firstRequest = await stableRuntime.createRequest({
        avatarTarget: { publicKey: "owner-pubkey" },
        conversationTurns: [{ role: "user", content: "第一次问题" }],
        stream: false,
      });
      await stableRuntime.run(firstRequest);

      const failingClient = createChatClient();
      vi.mocked(failingClient.chat)
        .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("第二次问题")))
        .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()))
        .mockResolvedValueOnce(createChatResponse("第二次回答"));
      const failingRuntime = new AvatarInferenceRuntime({
        ownerConn: createOwnerConn(999),
        chatClient: failingClient,
        embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
        debugArtifactWriter: createLatestReasoningDebugArtifactWriter({
          rootDir: tempRoot,
          testHooks: {
            beforeSwap() {
              throw new Error("swap failed");
            },
          },
        }),
      } as ConstructorParameters<typeof AvatarInferenceRuntime>[0]);

      const secondRequest = await failingRuntime.createRequest({
        avatarTarget: { publicKey: "owner-pubkey" },
        conversationTurns: [{ role: "user", content: "第二次问题" }],
        stream: false,
      });

      const response = await failingRuntime.run(secondRequest);

      expect(response).toEqual({
        message: { role: "assistant", content: "第二次回答" },
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      });

      const latestDir = join(tempRoot, "debug", "reasoning-last");
      expect((await lstat(latestDir)).isSymbolicLink()).toBe(true);
      expect(await readJson(join(latestDir, "summary.json"))).toEqual(
        expect.objectContaining({ userQuery: "第一次问题" }),
      );
      expect(await readFile(join(latestDir, "response.txt"), "utf8")).toBe("第一次回答");
      await expect(access(join(latestDir, "final-messages.json"))).resolves.toBeUndefined();
      await expect(
        access(join(latestDir, "03-final-generation-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        writeFile(join(tempRoot, "debug", "can-still-write.txt"), "ok", "utf8"),
      ).resolves.toBeUndefined();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("replaces a pre-existing real latest directory with managed runtime artifacts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "remi-runtime-artifact-"));

    try {
      const latestDir = join(tempRoot, "debug", "reasoning-last");
      await mkdir(latestDir, { recursive: true });
      await writeFile(join(latestDir, "obsolete.txt"), "legacy", "utf8");

      const chatClient = createChatClient();
      const { goalBasedRecall: actualGoalBasedRecall } = await vi.importActual<
        typeof import("../../src/recall/goal-based-recall.js")
      >("../../src/recall/goal-based-recall.js");
      mockGoalBasedRecall.mockImplementation((options) => actualGoalBasedRecall(options));
      vi.mocked(chatClient.chat)
        .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("替换旧目录")))
        .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()))
        .mockResolvedValueOnce(createChatResponse("最新回答"));

      const runtime = new AvatarInferenceRuntime({
        ownerConn: createOwnerConn(999),
        chatClient,
        embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
        debugArtifactWriter: createLatestReasoningDebugArtifactWriter({ rootDir: tempRoot }),
      });

      const request = await runtime.createRequest({
        avatarTarget: { publicKey: "owner-pubkey" },
        conversationTurns: [{ role: "user", content: "替换旧目录" }],
        stream: false,
      });
      await runtime.run(request);

      expect((await lstat(latestDir)).isSymbolicLink()).toBe(true);
      expect((await readdir(latestDir)).sort()).toContain("final-messages.json");
      await expect(access(join(latestDir, "obsolete.txt"))).rejects.toThrow();
      expect(await readJson(join(latestDir, "summary.json"))).toEqual(
        expect.objectContaining({ userQuery: "替换旧目录" }),
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not delete outside directories when latest symlink target is tampered", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "remi-runtime-artifact-"));

    try {
      const outsideDir = join(tempRoot, "outside-target");
      const latestDir = join(tempRoot, "debug", "reasoning-last");
      await mkdir(outsideDir, { recursive: true });
      await writeFile(join(outsideDir, "keep.txt"), "safe", "utf8");
      await mkdir(join(tempRoot, "debug"), { recursive: true });
      await symlink("../outside-target", latestDir, "dir");

      const chatClient = createChatClient();
      const { goalBasedRecall: actualGoalBasedRecall } = await vi.importActual<
        typeof import("../../src/recall/goal-based-recall.js")
      >("../../src/recall/goal-based-recall.js");
      mockGoalBasedRecall.mockImplementation((options) => actualGoalBasedRecall(options));
      vi.mocked(chatClient.chat)
        .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("tampered")))
        .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()))
        .mockResolvedValueOnce(createChatResponse("tampered response"));

      const runtime = new AvatarInferenceRuntime({
        ownerConn: createOwnerConn(999),
        chatClient,
        embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
        debugArtifactWriter: createLatestReasoningDebugArtifactWriter({ rootDir: tempRoot }),
      });

      const request = await runtime.createRequest({
        avatarTarget: { publicKey: "owner-pubkey" },
        conversationTurns: [{ role: "user", content: "tampered" }],
        stream: false,
      });
      await runtime.run(request);

      await expect(access(join(outsideDir, "keep.txt"))).resolves.toBeUndefined();
      expect(await readJson(join(latestDir, "summary.json"))).toEqual(
        expect.objectContaining({ userQuery: "tampered" }),
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes matching runtime trace artifacts for stream completion", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "remi-runtime-stream-artifact-"));

    try {
      const chatClient = createChatClient();
      const { goalBasedRecall: actualGoalBasedRecall } = await vi.importActual<
        typeof import("../../src/recall/goal-based-recall.js")
      >("../../src/recall/goal-based-recall.js");
      mockGoalBasedRecall.mockImplementation((options) => actualGoalBasedRecall(options));
      vi.mocked(chatClient.chat)
        .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("流式问题")))
        .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()));
      vi.mocked(chatClient.chatStream).mockImplementation(async function* () {
        yield "你好";
        yield "，我是流式分身";
      });

      const runtime = new AvatarInferenceRuntime({
        ownerConn: createOwnerConn(999),
        chatClient,
        embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
        debugArtifactWriter: createLatestReasoningDebugArtifactWriter({ rootDir: tempRoot }),
      } as ConstructorParameters<typeof AvatarInferenceRuntime>[0]);

      const request = await runtime.createRequest({
        avatarTarget: { publicKey: "owner-pubkey" },
        conversationTurns: [{ role: "user", content: "流式问题" }],
        stream: true,
      });
      const events: unknown[] = [];
      for await (const event of runtime.runStream(request)) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: "message_start", message: { role: "assistant" } },
        { type: "text_delta", text: "你好" },
        { type: "text_delta", text: "，我是流式分身" },
        { type: "message_end", finishReason: "stop" },
      ]);

      const latestDir = join(tempRoot, "debug", "reasoning-last");
      expect((await readdir(latestDir)).sort()).toEqual([
        "01-decomposition-prompt.json",
        "01-decomposition-prompt.md",
        "01-decomposition-response.json",
        "01-decomposition-response.txt",
        "02-sufficiency-round-1-prompt.json",
        "02-sufficiency-round-1-prompt.md",
        "02-sufficiency-round-1-response.json",
        "02-sufficiency-round-1-response.txt",
        "03-final-generation-prompt.json",
        "03-final-generation-prompt.md",
        "03-final-generation-response.txt",
        "final-messages.json",
        "final-prompt.md",
        "recall-rounds.json",
        "response.txt",
        "summary.json",
      ]);
      expect(await readFile(join(latestDir, "03-final-generation-response.txt"), "utf8")).toBe(
        "你好，我是流式分身",
      );
      expect(await readJson(join(latestDir, "final-messages.json"))).toEqual(
        runtime.buildMessages(request),
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("prepares matching unified runtime state for stream and non-stream requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-28T12:34:56.000Z"));

    try {
      const chatClient = createChatClient();
      const { goalBasedRecall: actualGoalBasedRecall } = await vi.importActual<
        typeof import("../../src/recall/goal-based-recall.js")
      >("../../src/recall/goal-based-recall.js");
      mockGoalBasedRecall.mockImplementation((options) => actualGoalBasedRecall(options));
      vi.mocked(chatClient.chat)
        .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("同一个问题")))
        .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()))
        .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("同一个问题")))
        .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()));

      const runtime = new AvatarInferenceRuntime({
        ownerConn: createOwnerConn(999),
        chatClient,
        embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
      });

      const prepareInference = (
        runtime as unknown as {
          prepareInference: (input: {
            avatarTarget: { publicKey: string };
            conversationTurns: AvatarInferenceRequest["conversationTurns"];
            stream: boolean;
          }) => Promise<{
            request: AvatarInferenceRequest;
            finalAnchorIds: string[];
            anchorSelectionStrategy: string;
            turns: { turnId: string }[];
          }>;
        }
      ).prepareInference.bind(runtime);

      const baseInput = {
        avatarTarget: { publicKey: "owner-pubkey" },
        conversationTurns: [
          { role: "system", content: "调用方系统补充" },
          { role: "user", content: "同一个问题" },
        ] as AvatarInferenceRequest["conversationTurns"],
      };

      const nonStreamPrepared = await prepareInference({ ...baseInput, stream: false });
      const streamPrepared = await prepareInference({ ...baseInput, stream: true });

      expect(runtime.buildMessages(nonStreamPrepared.request)).toEqual(
        runtime.buildMessages(streamPrepared.request),
      );
      expect(nonStreamPrepared.finalAnchorIds).toEqual(streamPrepared.finalAnchorIds);
      expect(nonStreamPrepared.anchorSelectionStrategy).toBe(
        streamPrepared.anchorSelectionStrategy,
      );
      expect(nonStreamPrepared.turns.map((turn) => turn.turnId)).toEqual([
        "01-decomposition",
        "02-sufficiency-round-1",
      ]);
      expect(streamPrepared.turns.map((turn) => turn.turnId)).toEqual([
        "01-decomposition",
        "02-sufficiency-round-1",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("separates raw runtime metadata from reasoning-facing storage metadata", async () => {
    const runtime = new AvatarInferenceRuntime({
      ownerConn: createOwnerConn(999),
      chatClient: createChatClient(),
      embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
    });

    const cachedAnchor: SoulAnchor = {
      id: "cached-anchor",
      question: "之前聊过什么",
      answer: "之前提过路线偏好",
      source: "interview",
      createdAt: Date.parse("2026-03-20T12:00:00.000Z"),
      updatedAt: Date.parse("2026-03-21T12:00:00.000Z"),
    };

    const { goalBasedRecall: actualGoalBasedRecall } = await vi.importActual<
      typeof import("../../src/recall/goal-based-recall.js")
    >("../../src/recall/goal-based-recall.js");
    mockGoalBasedRecall.mockImplementation((options) => actualGoalBasedRecall(options));
    vi.mocked(runtime["deps"].chatClient.chat)
      .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("继续之前的话题")))
      .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()));

    const request = await runtime.createRequest({
      avatarTarget: { publicKey: "owner-pubkey" },
      conversationTurns: [{ role: "user", content: "继续之前的话题" }],
      initialAnchors: [cachedAnchor],
      stream: true,
    });

    expect(mockGoalBasedRecall).toHaveBeenCalledWith(
      expect.objectContaining({ initialAnchors: [cachedAnchor] }),
    );
    expect(runtime.getPreparedMetadata(request)).toEqual({
      thinkingNarratives: ["思考中..."],
      recalledAnchorIds: ["cached-anchor", "anchor-1"],
      anchorSelectionStrategy: "recall-loop",
    });
    expect(runtime.getPreparedReasoningMetadata(request)).toEqual({
      thinkingNarratives: ["思考中..."],
      recalledAnchorIds: ["cached-anchor", "anchor-1"],
      anchorSelectionStrategy: "batch-recall",
    });
  });

  it("stores pending reasoning probes as runtime metadata instead of approval DTOs", async () => {
    const runtime = new AvatarInferenceRuntime({
      ownerConn: createOwnerConn(999),
      chatClient: createChatClient(),
      embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
    });

    const pendingReasoningProbes = [
      {
        displayQuestion: "我在做这类决定时还缺什么判断标准？",
        canonicalQuestion: "我在做这类决定时还缺什么判断标准？",
        kind: "judgment-gap" as const,
        sourceRef: "relationship_boundary",
        sourceSnapshot: { goalId: "relationship_boundary" },
      },
    ];
    const synthesizeGapProbesSpy = vi
      .spyOn(reasoningGapProbes, "synthesizeGapProbes")
      .mockResolvedValue({ probes: pendingReasoningProbes, stats: defaultProbeStats });

    try {
      const request = await runtime.createRequest({
        avatarTarget: { publicKey: "owner-pubkey" },
        conversationTurns: [{ role: "user", content: "帮我做个计划" }],
        stream: false,
      });

      expect(runtime.getPreparedReasoningProbeMetadata(request)).toEqual({
        pendingReasoningProbes,
        probeStats: defaultProbeStats,
      });
    } finally {
      synthesizeGapProbesSpy.mockRestore();
    }
  });

  it("returns deep-cloned reasoning probe metadata snapshots", async () => {
    const runtime = new AvatarInferenceRuntime({
      ownerConn: createOwnerConn(999),
      chatClient: createChatClient(),
      embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
    });

    const createPendingReasoningProbes = () => [
      {
        displayQuestion: "我在做这类决定时还缺什么判断标准？",
        canonicalQuestion: "我在做这类决定时还缺什么判断标准？",
        kind: "judgment-gap" as const,
        sourceRef: "relationship_boundary",
        sourceSnapshot: {
          goalId: "relationship_boundary",
          missingKeys: ["criteria"],
          nested: { labels: ["boundary"] },
        },
      },
    ];
    const pendingReasoningProbes = createPendingReasoningProbes();
    const synthesizeGapProbesSpy = vi
      .spyOn(reasoningGapProbes, "synthesizeGapProbes")
      .mockResolvedValue({ probes: pendingReasoningProbes, stats: defaultProbeStats });

    try {
      const request = await runtime.createRequest({
        avatarTarget: { publicKey: "owner-pubkey" },
        conversationTurns: [{ role: "user", content: "帮我做个计划" }],
        stream: false,
      });

      const firstMetadata = runtime.getPreparedReasoningProbeMetadata(request);
      expect(firstMetadata).toEqual({
        pendingReasoningProbes: createPendingReasoningProbes(),
        probeStats: defaultProbeStats,
      });

      const firstSnapshot = firstMetadata?.pendingReasoningProbes[0]?.sourceSnapshot as {
        missingKeys: string[];
        nested: { labels: string[] };
      };
      firstSnapshot.missingKeys.push("priority");
      firstSnapshot.nested.labels.push("judgment");

      expect(runtime.getPreparedReasoningProbeMetadata(request)).toEqual({
        pendingReasoningProbes: createPendingReasoningProbes(),
        probeStats: defaultProbeStats,
      });
    } finally {
      synthesizeGapProbesSpy.mockRestore();
    }
  });

  it("does not wait for probe flushing before returning a non-stream response", async () => {
    const chatClient = createChatClient();
    const { goalBasedRecall: actualGoalBasedRecall } = await vi.importActual<
      typeof import("../../src/recall/goal-based-recall.js")
    >("../../src/recall/goal-based-recall.js");
    mockGoalBasedRecall.mockImplementation((options) => actualGoalBasedRecall(options));
    vi.mocked(chatClient.chat)
      .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("非流式问题")))
      .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()))
      .mockResolvedValueOnce(createChatResponse("非流式回答"));

    let resolveFlush: (() => void) | undefined;
    const flushReasoningProbes = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFlush = resolve;
        }),
    );
    const synthesizeGapProbesSpy = vi
      .spyOn(reasoningGapProbes, "synthesizeGapProbes")
      .mockResolvedValue({
        probes: [
          {
            displayQuestion: "我在做这类决定时还缺什么判断标准？",
            canonicalQuestion: "我在做这类决定时还缺什么判断标准？",
            kind: "judgment-gap",
            sourceRef: "relationship_boundary",
            sourceSnapshot: { goalId: "relationship_boundary" },
          },
        ],
        stats: defaultProbeStats,
      });

    try {
      const runtime = new AvatarInferenceRuntime({
        ownerConn: createOwnerConn(999),
        chatClient,
        embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
        flushReasoningProbes,
      } as ConstructorParameters<typeof AvatarInferenceRuntime>[0]);

      const request = await runtime.createRequest({
        avatarTarget: { publicKey: "owner-pubkey" },
        conversationTurns: [{ role: "user", content: "非流式问题" }],
        stream: false,
      });

      const response = await runtime.run(request);

      expect(response).toEqual({
        message: { role: "assistant", content: "非流式回答" },
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      });
      expect(flushReasoningProbes).toHaveBeenCalledTimes(1);
      resolveFlush?.();
    } finally {
      synthesizeGapProbesSpy.mockRestore();
    }
  });

  it("does not wait for probe flushing before the first stream event sequence starts", async () => {
    const chatClient = createChatClient();
    const { goalBasedRecall: actualGoalBasedRecall } = await vi.importActual<
      typeof import("../../src/recall/goal-based-recall.js")
    >("../../src/recall/goal-based-recall.js");
    mockGoalBasedRecall.mockImplementation((options) => actualGoalBasedRecall(options));
    vi.mocked(chatClient.chat)
      .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("流式问题")))
      .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()));
    vi.mocked(chatClient.chatStream).mockImplementation(async function* () {
      yield "第一段";
      yield "第二段";
    });

    let resolveFlush: (() => void) | undefined;
    const flushReasoningProbes = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFlush = resolve;
        }),
    );
    const synthesizeGapProbesSpy = vi
      .spyOn(reasoningGapProbes, "synthesizeGapProbes")
      .mockResolvedValue({
        probes: [
          {
            displayQuestion: "我在这种关系里怎么设边界？",
            canonicalQuestion: "我在这种关系里怎么设边界？",
            kind: "judgment-gap",
            sourceRef: "relationship_boundary",
            sourceSnapshot: { goalId: "relationship_boundary" },
          },
        ],
        stats: defaultProbeStats,
      });

    try {
      const runtime = new AvatarInferenceRuntime({
        ownerConn: createOwnerConn(999),
        chatClient,
        embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
        flushReasoningProbes,
      } as ConstructorParameters<typeof AvatarInferenceRuntime>[0]);

      const request = await runtime.createRequest({
        avatarTarget: { publicKey: "owner-pubkey" },
        conversationTurns: [{ role: "user", content: "流式问题" }],
        stream: true,
      });

      const stream = runtime.runStream(request);
      const first = await stream.next();

      expect(first).toEqual({
        done: false,
        value: { type: "message_start", message: { role: "assistant" } },
      });

      const rest: unknown[] = [];
      for await (const event of stream) {
        rest.push(event);
      }

      expect(rest).toEqual([
        { type: "text_delta", text: "第一段" },
        { type: "text_delta", text: "第二段" },
        { type: "message_end", finishReason: "stop" },
      ]);
      expect(flushReasoningProbes).toHaveBeenCalledTimes(1);
      resolveFlush?.();
    } finally {
      synthesizeGapProbesSpy.mockRestore();
    }
  });

  it("does not change the response when detached probe flushing fails", async () => {
    const chatClient = createChatClient();
    const { goalBasedRecall: actualGoalBasedRecall } = await vi.importActual<
      typeof import("../../src/recall/goal-based-recall.js")
    >("../../src/recall/goal-based-recall.js");
    mockGoalBasedRecall.mockImplementation((options) => actualGoalBasedRecall(options));
    vi.mocked(chatClient.chat)
      .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("flush 失败")))
      .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()))
      .mockResolvedValueOnce(createChatResponse("回答保持成功"));

    const flushReasoningProbes = vi.fn().mockRejectedValue(new Error("probe write failed"));
    const synthesizeGapProbesSpy = vi
      .spyOn(reasoningGapProbes, "synthesizeGapProbes")
      .mockResolvedValue({
        probes: [
          {
            displayQuestion: "我还缺少什么信息？",
            canonicalQuestion: "我还缺少什么信息？",
            kind: "fact-gap",
            sourceRef: "domain_answer",
            sourceSnapshot: { goalId: "domain_answer" },
          },
        ],
        stats: defaultProbeStats,
      });

    try {
      const runtime = new AvatarInferenceRuntime({
        ownerConn: createOwnerConn(999),
        chatClient,
        embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
        flushReasoningProbes,
      } as ConstructorParameters<typeof AvatarInferenceRuntime>[0]);

      const request = await runtime.createRequest({
        avatarTarget: { publicKey: "owner-pubkey" },
        conversationTurns: [{ role: "user", content: "flush 失败" }],
        stream: false,
      });
      const response = await runtime.run(request);

      expect(response).toEqual({
        message: { role: "assistant", content: "回答保持成功" },
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      });
      expect(flushReasoningProbes).toHaveBeenCalledTimes(1);
    } finally {
      synthesizeGapProbesSpy.mockRestore();
    }
  });

  it("keeps flush hook probe mutations isolated from prepared metadata", async () => {
    const chatClient = createChatClient();
    const { goalBasedRecall: actualGoalBasedRecall } = await vi.importActual<
      typeof import("../../src/recall/goal-based-recall.js")
    >("../../src/recall/goal-based-recall.js");
    mockGoalBasedRecall.mockImplementation((options) => actualGoalBasedRecall(options));
    vi.mocked(chatClient.chat)
      .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("flush 隔离")))
      .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()))
      .mockResolvedValueOnce(createChatResponse("回答保持成功"));

    const createPendingReasoningProbes = () => [
      {
        displayQuestion: "我还缺少什么信息？",
        canonicalQuestion: "我还缺少什么信息？",
        kind: "fact-gap" as const,
        sourceRef: "domain_answer",
        sourceSnapshot: {
          goalId: "domain_answer",
          missingKeys: ["timeline"],
          nested: { labels: ["fact"] },
        },
      },
    ];
    const pendingReasoningProbes = createPendingReasoningProbes();
    const synthesizeGapProbesSpy = vi
      .spyOn(reasoningGapProbes, "synthesizeGapProbes")
      .mockResolvedValue({ probes: pendingReasoningProbes, stats: defaultProbeStats });

    let request!: AvatarInferenceRequest;
    let metadataSeenInsideFlush:
      | ReturnType<AvatarInferenceRuntime["getPreparedReasoningProbeMetadata"]>
      | undefined;
    const flushReasoningProbes = vi.fn(
      (batch: { pendingReasoningProbes: reasoningGapProbes.PendingReasoningProbe[] }) => {
        const snapshot = batch.pendingReasoningProbes[0]?.sourceSnapshot as {
          missingKeys: string[];
          nested: { labels: string[] };
        };
        snapshot.missingKeys.push("budget");
        snapshot.nested.labels.push("mutated-by-flush");
        metadataSeenInsideFlush = runtime.getPreparedReasoningProbeMetadata(request);
      },
    );

    const runtime = new AvatarInferenceRuntime({
      ownerConn: createOwnerConn(999),
      chatClient,
      embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
      flushReasoningProbes,
    } as ConstructorParameters<typeof AvatarInferenceRuntime>[0]);

    try {
      request = await runtime.createRequest({
        avatarTarget: { publicKey: "owner-pubkey" },
        conversationTurns: [{ role: "user", content: "flush 隔离" }],
        stream: false,
      });

      await runtime.run(request);

      expect(flushReasoningProbes).toHaveBeenCalledTimes(1);
      expect(metadataSeenInsideFlush).toEqual({
        pendingReasoningProbes: createPendingReasoningProbes(),
        probeStats: defaultProbeStats,
      });
    } finally {
      synthesizeGapProbesSpy.mockRestore();
    }
  });

  it("does not change the stream event sequence when detached probe flushing fails", async () => {
    const chatClient = createChatClient();
    const { goalBasedRecall: actualGoalBasedRecall } = await vi.importActual<
      typeof import("../../src/recall/goal-based-recall.js")
    >("../../src/recall/goal-based-recall.js");
    mockGoalBasedRecall.mockImplementation((options) => actualGoalBasedRecall(options));
    vi.mocked(chatClient.chat)
      .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("流式 flush 失败")))
      .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()));
    vi.mocked(chatClient.chatStream).mockImplementation(async function* () {
      yield "流式";
      yield "回答";
    });

    const flushReasoningProbes = vi.fn().mockRejectedValue(new Error("probe write failed"));
    const synthesizeGapProbesSpy = vi
      .spyOn(reasoningGapProbes, "synthesizeGapProbes")
      .mockResolvedValue({
        probes: [
          {
            displayQuestion: "我该先澄清什么？",
            canonicalQuestion: "我该先澄清什么？",
            kind: "term-gap",
            sourceRef: "domain_answer",
            sourceSnapshot: { goalId: "domain_answer" },
          },
        ],
        stats: defaultProbeStats,
      });

    try {
      const runtime = new AvatarInferenceRuntime({
        ownerConn: createOwnerConn(999),
        chatClient,
        embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
        flushReasoningProbes,
      } as ConstructorParameters<typeof AvatarInferenceRuntime>[0]);

      const request = await runtime.createRequest({
        avatarTarget: { publicKey: "owner-pubkey" },
        conversationTurns: [{ role: "user", content: "流式 flush 失败" }],
        stream: true,
      });

      const events: unknown[] = [];
      for await (const event of runtime.runStream(request)) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: "message_start", message: { role: "assistant" } },
        { type: "text_delta", text: "流式" },
        { type: "text_delta", text: "回答" },
        { type: "message_end", finishReason: "stop" },
      ]);
      expect(flushReasoningProbes).toHaveBeenCalledTimes(1);
    } finally {
      synthesizeGapProbesSpy.mockRestore();
    }
  });

  it("returns undefined prepared metadata after prepared state is consumed", async () => {
    const chatClient = createChatClient();
    const { goalBasedRecall: actualGoalBasedRecall } = await vi.importActual<
      typeof import("../../src/recall/goal-based-recall.js")
    >("../../src/recall/goal-based-recall.js");
    mockGoalBasedRecall.mockImplementation((options) => actualGoalBasedRecall(options));
    vi.mocked(chatClient.chat)
      .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("原问题")))
      .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()))
      .mockResolvedValueOnce(createChatResponse("最终回答"));

    const runtime = new AvatarInferenceRuntime({
      ownerConn: createOwnerConn(999),
      chatClient,
      embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
    });

    const request = await runtime.createRequest({
      avatarTarget: { publicKey: "owner-pubkey" },
      conversationTurns: [{ role: "user", content: "原问题" }],
      stream: false,
    });

    await runtime.run(request);

    expect(runtime.getPreparedMetadata(request)).toBeUndefined();
    expect(runtime.getPreparedReasoningMetadata(request)).toBeUndefined();
  });

  it("rebuilds downstream messages from the mutable request at send time", async () => {
    const chatClient = createChatClient();
    const { goalBasedRecall: actualGoalBasedRecall } = await vi.importActual<
      typeof import("../../src/recall/goal-based-recall.js")
    >("../../src/recall/goal-based-recall.js");
    mockGoalBasedRecall.mockImplementation((options) => actualGoalBasedRecall(options));
    vi.mocked(chatClient.chat)
      .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("原问题")))
      .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()))
      .mockResolvedValueOnce(createChatResponse("最终回答"));

    const runtime = new AvatarInferenceRuntime({
      ownerConn: createOwnerConn(999),
      chatClient,
      embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
    });

    const request = await runtime.createRequest({
      avatarTarget: { publicKey: "owner-pubkey" },
      conversationTurns: [{ role: "user", content: "原问题" }],
      stream: false,
    });

    request.conversationTurns[0] = { role: "user", content: "已修改的问题" };

    await runtime.run(request);

    const finalCall = vi.mocked(chatClient.chat).mock.calls[
      vi.mocked(chatClient.chat).mock.calls.length - 1
    ]?.[0].messages;
    expect(finalCall).toEqual(runtime.buildMessages(request));
    expect(finalCall?.[1]?.content).toBe("已修改的问题");
  });

  it("cleans prepared state when non-stream inference fails", async () => {
    const chatClient = createChatClient();
    const { goalBasedRecall: actualGoalBasedRecall } = await vi.importActual<
      typeof import("../../src/recall/goal-based-recall.js")
    >("../../src/recall/goal-based-recall.js");
    mockGoalBasedRecall.mockImplementation((options) => actualGoalBasedRecall(options));
    vi.mocked(chatClient.chat)
      .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("失败问题")))
      .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()))
      .mockRejectedValueOnce(new Error("upstream exploded"));

    const runtime = new AvatarInferenceRuntime({
      ownerConn: createOwnerConn(999),
      chatClient,
      embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
    });

    const request = await runtime.createRequest({
      avatarTarget: { publicKey: "owner-pubkey" },
      conversationTurns: [{ role: "user", content: "失败问题" }],
      stream: false,
    });

    await expect(runtime.run(request)).rejects.toThrow("upstream exploded");

    request.instructionSegments.recall = "mutated recall tail";
    const rebuiltMessages = runtime.buildMessages(request);
    expect(rebuiltMessages[rebuiltMessages.length - 1]?.content).toBe("mutated recall tail");
  });

  it("cleans prepared state when stream inference fails", async () => {
    const chatClient = createChatClient();
    vi.mocked(chatClient.chat)
      .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("流式失败问题")))
      .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()));
    vi.mocked(chatClient.chatStream).mockImplementation(
      () =>
        ({
          [Symbol.asyncIterator]() {
            throw new Error("stream exploded");
          },
        }) as unknown as AsyncGenerator<string>,
    );

    const runtime = new AvatarInferenceRuntime({
      ownerConn: createOwnerConn(999),
      chatClient,
      embeddingClient: null,
    });

    const request = await runtime.createRequest({
      avatarTarget: { publicKey: "owner-pubkey" },
      conversationTurns: [{ role: "user", content: "流式失败问题" }],
      stream: true,
    });

    await expect(async () => {
      for await (const event of runtime.runStream(request)) {
        void event;
        // consume until failure
      }
    }).rejects.toThrow("stream exploded");

    request.instructionSegments.recall = "mutated recall tail";
    const rebuiltMessages = runtime.buildMessages(request);
    expect(rebuiltMessages[rebuiltMessages.length - 1]?.content).toBe("mutated recall tail");
  });

  it("keeps successful stream inference even when runtime artifact write fails", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "remi-runtime-stream-artifact-"));

    try {
      const chatClient = createChatClient();
      const { goalBasedRecall: actualGoalBasedRecall } = await vi.importActual<
        typeof import("../../src/recall/goal-based-recall.js")
      >("../../src/recall/goal-based-recall.js");
      mockGoalBasedRecall.mockImplementation((options) => actualGoalBasedRecall(options));
      vi.mocked(chatClient.chat)
        .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("流式失败写盘")))
        .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()));
      vi.mocked(chatClient.chatStream).mockImplementation(async function* () {
        yield "流式";
        yield "成功";
      });

      const runtime = new AvatarInferenceRuntime({
        ownerConn: createOwnerConn(999),
        chatClient,
        embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
        debugArtifactWriter: createLatestReasoningDebugArtifactWriter({
          rootDir: tempRoot,
          testHooks: {
            beforeSwap() {
              throw new Error("swap failed");
            },
          },
        }),
      } as ConstructorParameters<typeof AvatarInferenceRuntime>[0]);

      const request = await runtime.createRequest({
        avatarTarget: { publicKey: "owner-pubkey" },
        conversationTurns: [{ role: "user", content: "流式失败写盘" }],
        stream: true,
      });

      const events: unknown[] = [];
      for await (const event of runtime.runStream(request)) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: "message_start", message: { role: "assistant" } },
        { type: "text_delta", text: "流式" },
        { type: "text_delta", text: "成功" },
        { type: "message_end", finishReason: "stop" },
      ]);
      await expect(access(join(tempRoot, "debug", "reasoning-last"))).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
