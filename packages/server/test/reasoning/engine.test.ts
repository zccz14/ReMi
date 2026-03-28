import { access, lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ReasoningEngine } from "../../src/reasoning/engine.js";
import type { ChatResponse } from "../../src/llm/client.js";
import { createLatestReasoningDebugArtifactWriter } from "../../src/reasoning/debug-artifact.js";
import type { SoulAnchor } from "../../src/types.js";

const THRESHOLD = 20;

function createAnchor(id: string, question: string): SoulAnchor {
  return {
    id,
    question,
    answer: `${question} 的答案`,
    source: "interview",
    createdAt: Date.parse("2026-03-26T12:00:00.000Z"),
    updatedAt: Date.parse("2026-03-27T21:13:08.000Z"),
  };
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
        knownAnchorIds: ["a1"],
        missingKeys: [],
      },
      {
        goalId: "relationship_boundary",
        sufficient: true,
        known: ["知道关系边界"],
        missing: [],
        knownAnchorIds: ["a1"],
        missingKeys: [],
      },
      {
        goalId: "domain_answer",
        sufficient: true,
        known: ["已有回答所需认知"],
        missing: [],
        knownAnchorIds: ["a1"],
        missingKeys: [],
      },
    ],
    nextQuery: "",
    reasoningChain: ["已有锚点足以支撑回答"],
    narrative: "思考中...",
    ...overrides,
  });
}

function createMockDeps() {
  const chatClient = {
    chat: vi
      .fn()
      .mockResolvedValueOnce(createChatResponse(createDecompositionResponse()))
      .mockResolvedValueOnce(createChatResponse(createAssessmentResponse())),
    chatStream: vi.fn(async function* () {
      yield "你好";
      yield "，我是分身";
    }),
  };
  const embeddingClient = {
    embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
  };

  return {
    chatClient,
    embeddingClient,
    countAnchors: vi.fn().mockResolvedValue(THRESHOLD + 1),
    listAnchors: vi.fn().mockResolvedValue([]),
    getMessages: vi.fn().mockResolvedValue([]),
    saveMessage: vi
      .fn()
      .mockResolvedValueOnce({ messageId: 1, sharedMessageId: "shared-user" })
      .mockResolvedValueOnce({ messageId: 2, sharedMessageId: "shared-assistant" }),
    searchAnchors: vi.fn().mockResolvedValue([createAnchor("a1", "我是谁")]),
    getCachedAnchorIds: vi.fn().mockResolvedValue([]),
    getAnchorsByIds: vi.fn().mockResolvedValue([]),
  };
}

function createEmitter(events: { type: string; data: unknown }[]) {
  return {
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
}

function getGenerationPrompt(deps: ReturnType<typeof createMockDeps>): string {
  const calls = deps.chatClient.chatStream.mock.calls as unknown as Array<
    Array<{ messages?: Array<{ content: string }> }>
  >;
  const call = (calls[0]?.[0] ?? null) as {
    messages?: Array<{ content: string }>;
  } | null;
  return call?.messages?.[0]?.content ?? "";
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function expectGoalStatusShape(goalStatus: unknown, sufficient: boolean) {
  expect(goalStatus).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        goalId: expect.any(String),
        sufficient,
        knownAnchorIds: expect.any(Array),
        missingKeys: expect.any(Array),
      }),
    ]),
  );
}

describe("ReasoningEngine", () => {
  it("should run handleMessage flow", async () => {
    const deps = createMockDeps();
    const events: { type: string; data: unknown }[] = [];

    await new ReasoningEngine(deps).handleMessage("你好", "visitor-pub-key", createEmitter(events));

    expect(events.filter((event) => event.type === "token")).toHaveLength(2);
    expect(events.find((event) => event.type === "done")).toBeDefined();
    expect(deps.chatClient.chat).toHaveBeenCalledTimes(2);
    expect(deps.getCachedAnchorIds).toHaveBeenCalled();
  });

  it("should fallback to default decomposition goals when JSON is invalid", async () => {
    const deps = createMockDeps();
    deps.chatClient.chat.mockReset();
    deps.chatClient.chat
      .mockResolvedValueOnce(createChatResponse("not-json"))
      .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()));

    const events: { type: string; data: unknown }[] = [];
    await new ReasoningEngine(deps).handleMessage("你好", "visitor-key", createEmitter(events));

    const assessmentPrompt = deps.chatClient.chat.mock.calls[1][0].messages[1].content;
    expect(assessmentPrompt).toContain("identity_style");
    expect(assessmentPrompt).toContain("relationship_boundary");
    expect(assessmentPrompt).toContain("domain_answer");
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  it("should fallback to default goals when decomposition JSON misses required goals", async () => {
    const deps = createMockDeps();
    deps.chatClient.chat.mockReset();
    deps.chatClient.chat
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

    await new ReasoningEngine(deps).handleMessage("你好", "visitor-key", {
      emitThinking: vi.fn(),
      emitToken: vi.fn(),
      emitDone: vi.fn(),
      emitError: vi.fn(),
    });

    const assessmentPrompt = deps.chatClient.chat.mock.calls[1][0].messages[1].content;
    expect(assessmentPrompt).toContain("identity_style");
    expect(assessmentPrompt).toContain("relationship_boundary");
    expect(assessmentPrompt).toContain("domain_answer");
  });

  it("should fallback to default goals when time sensitive decomposition omits temporal validity", async () => {
    const deps = createMockDeps();
    deps.chatClient.chat.mockReset();
    deps.chatClient.chat
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

    await new ReasoningEngine(deps).handleMessage("我最近怎么样？", "visitor-key", {
      emitThinking: vi.fn(),
      emitToken: vi.fn(),
      emitDone: vi.fn(),
      emitError: vi.fn(),
    });

    const assessmentPrompt = deps.chatClient.chat.mock.calls[1][0].messages[1].content;
    expect(assessmentPrompt).toContain("identity_style");
    expect(assessmentPrompt).toContain("relationship_boundary");
    expect(assessmentPrompt).toContain("domain_answer");
    expect(assessmentPrompt).toContain("temporal_validity");
  });

  it("should ignore model supplied userQuery and currentTime in favor of engine owned values", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-28T12:34:56.000Z"));

    try {
      const deps = createMockDeps();
      deps.chatClient.chat.mockReset();
      deps.chatClient.chat
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
        .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()));

      await new ReasoningEngine(deps).handleMessage("真实用户问题", "visitor-key", {
        emitThinking: vi.fn(),
        emitToken: vi.fn(),
        emitDone: vi.fn(),
        emitError: vi.fn(),
      });

      const prompt = getGenerationPrompt(deps);
      expect(prompt).toContain("## User Question\n真实用户问题");
      expect(prompt).not.toContain("被模型改写的问题");
      expect(prompt).toContain("## Current Time\n2026-03-28T12:34:56.000Z");
      expect(prompt).not.toContain("1999-01-01T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("should include current time in final structured generation prompt", async () => {
    const deps = createMockDeps();

    await new ReasoningEngine(deps).handleMessage("你好", "visitor-key", {
      emitThinking: vi.fn(),
      emitToken: vi.fn(),
      emitDone: vi.fn(),
      emitError: vi.fn(),
    });

    const prompt = getGenerationPrompt(deps);
    expect(prompt).toContain("## Current Time");
    expect(prompt).toContain("## User Question");
  });

  it("should use structured generation prompt for full injection", async () => {
    const deps = createMockDeps();
    deps.saveMessage.mockReset();
    deps.saveMessage
      .mockResolvedValueOnce({ messageId: 1, sharedMessageId: "shared-user" })
      .mockResolvedValueOnce({ messageId: 2, sharedMessageId: "shared-assistant" });
    deps.countAnchors.mockResolvedValue(THRESHOLD);
    deps.listAnchors.mockResolvedValue([
      createAnchor("a1", "我是谁"),
      createAnchor("a2", "我的风格"),
    ]);

    await new ReasoningEngine(deps).handleMessage("你好", "visitor-key", {
      emitThinking: vi.fn(),
      emitToken: vi.fn(),
      emitDone: vi.fn(),
      emitError: vi.fn(),
    });

    const prompt = getGenerationPrompt(deps);
    expect(prompt).toContain("## Evidence");
    expect(prompt).toContain("## Missing Information");
    expect(prompt).toContain("## Non-evidence Reasoning");
    expect(prompt).toContain("UpdatedAt: 2026-03-27T21:13:08.000Z");
    expect(deps.getCachedAnchorIds).not.toHaveBeenCalled();
    expect(deps.embeddingClient.embed).not.toHaveBeenCalled();
    expect(deps.chatClient.chat).toHaveBeenCalledTimes(2);
  });

  it("should hand reasoning chain and missing information into final generation prompt", async () => {
    const deps = createMockDeps();
    deps.chatClient.chat.mockReset();
    deps.chatClient.chat
      .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("我最近怎么样？")))
      .mockResolvedValueOnce(
        createChatResponse(
          createAssessmentResponse({
            sufficient: false,
            goalStatus: [
              {
                goalId: "identity_style",
                sufficient: true,
                known: ["知道身份风格"],
                missing: [],
                knownAnchorIds: ["a1"],
                missingKeys: [],
              },
              {
                goalId: "relationship_boundary",
                sufficient: true,
                known: ["知道关系边界"],
                missing: [],
                knownAnchorIds: ["a1"],
                missingKeys: [],
              },
              {
                goalId: "domain_answer",
                sufficient: false,
                known: ["已有部分信息"],
                missing: ["缺少更近期更新"],
                knownAnchorIds: ["a1"],
                missingKeys: ["recent-position"],
              },
            ],
            nextQuery: "查找更近期更新",
            reasoningChain: ["已有锚点能部分回答，但近期性仍需保守处理"],
          }),
        ),
      );
    deps.searchAnchors.mockResolvedValue([]);

    await new ReasoningEngine(deps).handleMessage("我最近怎么样？", "visitor-key", {
      emitThinking: vi.fn(),
      emitToken: vi.fn(),
      emitDone: vi.fn(),
      emitError: vi.fn(),
    });

    const prompt = getGenerationPrompt(deps);
    expect(prompt).toContain("## Missing Information");
    expect(prompt).toContain("- 缺少更近期更新");
    expect(prompt).toContain("## Non-evidence Reasoning");
    expect(prompt).toContain("已有锚点能部分回答，但近期性仍需保守处理");
    expect(prompt).toContain("StoppedBecause: no-new-anchors");
  });

  it("should not leak reasoning chain when judgment parsing fails", async () => {
    const deps = createMockDeps();
    deps.chatClient.chat.mockReset();
    deps.chatClient.chat
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

    await new ReasoningEngine(deps).handleMessage("test", "visitor-key", {
      emitThinking: vi.fn(),
      emitToken: vi.fn(),
      emitDone: vi.fn(),
      emitError: vi.fn(),
    });

    const prompt = getGenerationPrompt(deps);
    expect(prompt).toContain("StoppedBecause: parse-failure");
    expect(prompt).not.toContain("这条链路不该泄漏");
    expect(prompt).not.toContain("这条链路也不该泄漏");
  });

  it("should continue to final answer generation when recall is insufficient", async () => {
    const deps = createMockDeps();
    deps.chatClient.chat.mockReset();
    deps.chatClient.chat
      .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("test")))
      .mockResolvedValueOnce(
        createChatResponse(
          createAssessmentResponse({
            sufficient: false,
            goalStatus: [
              {
                goalId: "identity_style",
                sufficient: false,
                known: [],
                missing: ["不知道身份风格"],
                knownAnchorIds: [],
                missingKeys: ["identity-unknown"],
              },
              {
                goalId: "relationship_boundary",
                sufficient: false,
                known: [],
                missing: ["不知道关系边界"],
                knownAnchorIds: [],
                missingKeys: ["visitor-boundary"],
              },
              {
                goalId: "domain_answer",
                sufficient: false,
                known: [],
                missing: ["不知道问题答案"],
                knownAnchorIds: [],
                missingKeys: ["domain-fact-missing"],
              },
            ],
            nextQuery: "继续找",
            reasoningChain: ["证据不足，只能保守回答"],
          }),
        ),
      );
    deps.searchAnchors.mockResolvedValue([]);

    const emitDone = vi.fn();
    const emitError = vi.fn();
    await new ReasoningEngine(deps).handleMessage("test", "visitor-key", {
      emitThinking: vi.fn(),
      emitToken: vi.fn(),
      emitDone,
      emitError,
    });

    expect(deps.chatClient.chatStream).toHaveBeenCalledTimes(1);
    expect(emitDone).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 2, content: "你好，我是分身" }),
    );
    expect(emitError).not.toHaveBeenCalled();
  });

  it("should allow full injection without embedding client", async () => {
    const deps = createMockDeps();
    deps.saveMessage.mockReset();
    deps.saveMessage
      .mockResolvedValueOnce({ messageId: 1, sharedMessageId: "shared-user" })
      .mockResolvedValueOnce({ messageId: 2, sharedMessageId: "shared-assistant" });
    deps.countAnchors.mockResolvedValue(0);
    deps.listAnchors.mockResolvedValue([createAnchor("a1", "我是谁")]);

    const events: { type: string; data: unknown }[] = [];
    await new ReasoningEngine({ ...deps, embeddingClient: undefined }).handleMessage(
      "你好",
      "visitor-key",
      createEmitter(events),
    );

    expect(events.some((event) => event.type === "token")).toBe(true);
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("should emit clear error when recall path lacks embedding client", async () => {
    const deps = createMockDeps();
    deps.countAnchors.mockResolvedValue(THRESHOLD + 1);

    const emitError = vi.fn();
    await new ReasoningEngine({ ...deps, embeddingClient: undefined }).handleMessage(
      "test",
      "visitor-key",
      {
        emitThinking: vi.fn(),
        emitToken: vi.fn(),
        emitDone: vi.fn(),
        emitError,
      },
    );

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

    await new ReasoningEngine(deps).handleMessage("hello", "visitor-key", {
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

  it("should emit error on LLM failure", async () => {
    const deps = createMockDeps();
    deps.chatClient.chat.mockReset();
    deps.chatClient.chat.mockRejectedValue(new Error("LLM down"));

    const events: { type: string; data: unknown }[] = [];
    await new ReasoningEngine(deps).handleMessage("test", "visitor-key", createEmitter(events));

    expect(events.find((event) => event.type === "error")).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ code: "LLM_ERROR", msg: "LLM down" }),
      }),
    );
  });

  it("writes latest reasoning debug artifact when explicitly configured", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "remi-reasoning-artifact-"));

    try {
      const deps = createMockDeps();
      const engine = new ReasoningEngine({
        ...deps,
        debugArtifactWriter: createLatestReasoningDebugArtifactWriter({
          rootDir: tempRoot,
        }),
      });

      await engine.handleMessage("你好", "visitor-key", {
        emitThinking: vi.fn(),
        emitToken: vi.fn(),
        emitDone: vi.fn(),
        emitError: vi.fn(),
      });

      const latestDir = join(tempRoot, "debug", "reasoning-last");
      expect((await lstat(latestDir)).isSymbolicLink()).toBe(true);
      expect((await readdir(latestDir)).sort()).toEqual([
        "decomposition.json",
        "final-prompt.md",
        "recall-rounds.json",
        "request.json",
        "response.txt",
        "summary.json",
      ]);
      const summary = await readJson<{
        currentTime: string;
        userQuery: string;
        rounds: number;
        stoppedBecause: string | null;
        finalAnchorIds: string[];
        hasUnsatisfiedRequiredGoal: boolean;
      }>(join(latestDir, "summary.json"));
      const recallRounds = await readJson<
        Array<{
          round: number;
          query: string;
          newAnchorIds: string[];
          allAnchorIds: string[];
          normalizedGoalStatus: Array<{
            goalId: string;
            sufficient: boolean;
            knownAnchorIds: string[];
            missingKeys: string[];
          }>;
          stoppedCandidate: string | null;
        }>
      >(join(latestDir, "recall-rounds.json"));

      expect(await readFile(join(latestDir, "request.json"), "utf8")).toContain("visitor-key");
      expect(await readFile(join(latestDir, "decomposition.json"), "utf8")).toContain(
        "identity_style",
      );
      expect(await readFile(join(latestDir, "final-prompt.md"), "utf8")).toContain(
        "## User Question",
      );
      expect(await readFile(join(latestDir, "response.txt"), "utf8")).toBe("你好，我是分身");
      expect(summary).toEqual({
        currentTime: expect.any(String),
        userQuery: "你好",
        rounds: 1,
        stoppedBecause: "sufficient",
        finalAnchorIds: ["a1"],
        hasUnsatisfiedRequiredGoal: false,
      });
      expect(recallRounds).toHaveLength(1);
      expect(recallRounds[0]).toEqual({
        round: 1,
        query: "",
        newAnchorIds: ["a1"],
        allAnchorIds: ["a1"],
        normalizedGoalStatus: expect.any(Array),
        stoppedCandidate: "sufficient",
      });
      expectGoalStatusShape(recallRounds[0]?.normalizedGoalStatus, true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("replaces prior latest reasoning artifact contents on subsequent runs", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "remi-reasoning-artifact-"));

    try {
      const firstDeps = createMockDeps();
      const writer = createLatestReasoningDebugArtifactWriter({ rootDir: tempRoot });
      await new ReasoningEngine({ ...firstDeps, debugArtifactWriter: writer }).handleMessage(
        "第一次问题",
        "visitor-key",
        {
          emitThinking: vi.fn(),
          emitToken: vi.fn(),
          emitDone: vi.fn(),
          emitError: vi.fn(),
        },
      );

      const secondDeps = createMockDeps();
      secondDeps.chatClient.chat.mockReset();
      secondDeps.chatClient.chat
        .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("第二次问题")))
        .mockResolvedValueOnce(
          createChatResponse(
            createAssessmentResponse({
              sufficient: false,
              goalStatus: [
                {
                  goalId: "identity_style",
                  sufficient: false,
                  known: [],
                  missing: ["不知道身份风格"],
                  knownAnchorIds: [],
                  missingKeys: ["identity-unknown"],
                },
                {
                  goalId: "relationship_boundary",
                  sufficient: false,
                  known: [],
                  missing: ["不知道关系边界"],
                  knownAnchorIds: [],
                  missingKeys: ["visitor-boundary"],
                },
                {
                  goalId: "domain_answer",
                  sufficient: false,
                  known: [],
                  missing: ["不知道问题答案"],
                  knownAnchorIds: [],
                  missingKeys: ["domain-fact-missing"],
                },
                {
                  goalId: "optional_goal",
                  sufficient: false,
                  known: [],
                  missing: ["可选目标未满足"],
                  knownAnchorIds: [],
                  missingKeys: ["other"],
                },
              ],
              nextQuery: "继续找",
            }),
          ),
        );
      secondDeps.searchAnchors.mockResolvedValue([]);

      await new ReasoningEngine({ ...secondDeps, debugArtifactWriter: writer }).handleMessage(
        "第二次问题",
        "visitor-key",
        {
          emitThinking: vi.fn(),
          emitToken: vi.fn(),
          emitDone: vi.fn(),
          emitError: vi.fn(),
        },
      );

      const latestDir = join(tempRoot, "debug", "reasoning-last");
      expect((await readdir(latestDir)).sort()).toEqual([
        "decomposition.json",
        "final-prompt.md",
        "recall-rounds.json",
        "request.json",
        "response.txt",
        "summary.json",
      ]);
      const summary = await readJson<{
        userQuery: string;
        rounds: number;
        stoppedBecause: string | null;
        hasUnsatisfiedRequiredGoal: boolean;
      }>(join(latestDir, "summary.json"));
      const request = await readJson<{ userQuery: string }>(join(latestDir, "request.json"));
      const recallRounds = await readJson<
        Array<{
          round: number;
          query: string;
          newAnchorIds: string[];
          allAnchorIds: string[];
          normalizedGoalStatus: Array<{
            goalId: string;
            sufficient: boolean;
            knownAnchorIds: string[];
            missingKeys: string[];
          }>;
          stoppedCandidate: string | null;
        }>
      >(join(latestDir, "recall-rounds.json"));

      expect(summary).toEqual({
        currentTime: expect.any(String),
        userQuery: "第二次问题",
        rounds: 1,
        stoppedBecause: "no-new-anchors",
        finalAnchorIds: [],
        hasUnsatisfiedRequiredGoal: true,
      });
      expect(request.userQuery).toBe("第二次问题");
      expect(recallRounds).toHaveLength(1);
      expect(recallRounds[0]).toEqual({
        round: 1,
        query: "",
        newAnchorIds: [],
        allAnchorIds: [],
        normalizedGoalStatus: expect.any(Array),
        stoppedCandidate: "no-new-anchors",
      });
      expectGoalStatusShape(recallRounds[0]?.normalizedGoalStatus, false);
      await expect(access(join(latestDir, "summary.json"))).resolves.toBeUndefined();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not write reasoning debug artifact without explicit config", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "remi-reasoning-artifact-"));

    try {
      const deps = createMockDeps();
      await new ReasoningEngine(deps).handleMessage("你好", "visitor-key", {
        emitThinking: vi.fn(),
        emitToken: vi.fn(),
        emitDone: vi.fn(),
        emitError: vi.fn(),
      });

      await expect(access(join(tempRoot, "debug", "reasoning-last"))).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes stable recall round schema with null stoppedCandidate when a round continues", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "remi-reasoning-artifact-"));

    try {
      const deps = createMockDeps();
      deps.chatClient.chat.mockReset();
      deps.chatClient.chat
        .mockResolvedValueOnce(createChatResponse(createDecompositionResponse("两轮问题")))
        .mockResolvedValueOnce(
          createChatResponse(
            createAssessmentResponse({
              sufficient: false,
              goalStatus: [
                {
                  goalId: "identity_style",
                  sufficient: false,
                  known: [],
                  missing: ["缺少身份信息"],
                  knownAnchorIds: [],
                  missingKeys: ["identity-unknown"],
                },
                {
                  goalId: "relationship_boundary",
                  sufficient: false,
                  known: [],
                  missing: ["缺少关系信息"],
                  knownAnchorIds: [],
                  missingKeys: ["visitor-boundary"],
                },
                {
                  goalId: "domain_answer",
                  sufficient: false,
                  known: [],
                  missing: ["缺少答案信息"],
                  knownAnchorIds: [],
                  missingKeys: ["domain-fact-missing"],
                },
              ],
              nextQuery: "补充查询",
            }),
          ),
        )
        .mockResolvedValueOnce(createChatResponse(createAssessmentResponse()));
      deps.searchAnchors
        .mockResolvedValueOnce([createAnchor("a1", "我是谁")])
        .mockResolvedValueOnce([createAnchor("a1", "我是谁"), createAnchor("a2", "关系")]);

      await new ReasoningEngine({
        ...deps,
        debugArtifactWriter: createLatestReasoningDebugArtifactWriter({ rootDir: tempRoot }),
      }).handleMessage("两轮问题", "visitor-key", {
        emitThinking: vi.fn(),
        emitToken: vi.fn(),
        emitDone: vi.fn(),
        emitError: vi.fn(),
      });

      const recallRounds = await readJson<
        Array<{
          round: number;
          query: string;
          newAnchorIds: string[];
          allAnchorIds: string[];
          normalizedGoalStatus: Array<{
            goalId: string;
            sufficient: boolean;
            knownAnchorIds: string[];
            missingKeys: string[];
          }>;
          stoppedCandidate: string | null;
        }>
      >(join(tempRoot, "debug", "reasoning-last", "recall-rounds.json"));

      expect(recallRounds).toHaveLength(2);
      expect(recallRounds[0]).toEqual({
        round: 1,
        query: "",
        newAnchorIds: ["a1"],
        allAnchorIds: ["a1"],
        normalizedGoalStatus: expect.any(Array),
        stoppedCandidate: null,
      });
      expect(recallRounds[1]).toEqual({
        round: 2,
        query: "补充查询",
        newAnchorIds: ["a2"],
        allAnchorIds: ["a1", "a2"],
        normalizedGoalStatus: expect.any(Array),
        stoppedCandidate: "sufficient",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps previous latest readable when debug artifact swap fails", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "remi-reasoning-artifact-"));

    try {
      const stableWriter = createLatestReasoningDebugArtifactWriter({ rootDir: tempRoot });
      await new ReasoningEngine({
        ...createMockDeps(),
        debugArtifactWriter: stableWriter,
      }).handleMessage("第一次问题", "visitor-key", {
        emitThinking: vi.fn(),
        emitToken: vi.fn(),
        emitDone: vi.fn(),
        emitError: vi.fn(),
      });

      const failingWriter = createLatestReasoningDebugArtifactWriter({
        rootDir: tempRoot,
        testHooks: {
          beforeSwap() {
            throw new Error("swap failed");
          },
        },
      });

      await new ReasoningEngine({
        ...createMockDeps(),
        debugArtifactWriter: failingWriter,
      }).handleMessage("第二次问题", "visitor-key", {
        emitThinking: vi.fn(),
        emitToken: vi.fn(),
        emitDone: vi.fn(),
        emitError: vi.fn(),
      });

      const latestDir = join(tempRoot, "debug", "reasoning-last");
      expect((await lstat(latestDir)).isSymbolicLink()).toBe(true);
      expect(await readJson(join(latestDir, "request.json"))).toEqual(
        expect.objectContaining({ userQuery: "第一次问题" }),
      );
      expect(await readJson(join(latestDir, "summary.json"))).toEqual(
        expect.objectContaining({ userQuery: "第一次问题" }),
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
