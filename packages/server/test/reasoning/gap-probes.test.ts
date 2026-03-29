import { describe, expect, it, vi } from "vitest";
import type { SoulAnchor } from "../../src/types.js";
import {
  buildReasoningGapProbePrompt,
  type ReasoningGoalStatus,
} from "../../src/reasoning/prompts.js";
import {
  synthesizeGapProbes,
  type ReasoningGapProbeDraft,
} from "../../src/reasoning/gap-probes.js";

function createAnchor(overrides: Partial<SoulAnchor> = {}): SoulAnchor {
  return {
    id: "a1",
    question: "我在这种关系里怎么设边界？",
    answer: "先说明我的界限，再决定要不要继续投入",
    source: "interview",
    createdAt: Date.parse("2026-03-29T10:00:00.000Z"),
    updatedAt: Date.parse("2026-03-29T10:00:00.000Z"),
    ...overrides,
  };
}

function createGoalStatus(overrides: Partial<ReasoningGoalStatus> = {}): ReasoningGoalStatus {
  return {
    goalId: "relationship_boundary",
    sufficient: false,
    known: [],
    missing: ["我和对方现在是什么关系", "我通常在这种关系里怎么设边界"],
    knownAnchorIds: [],
    missingKeys: ["relationship-status", "boundary-style"],
    ...overrides,
  };
}

function mockDrafts(drafts: ReasoningGapProbeDraft[]) {
  return vi.fn(async () => drafts);
}

describe("reasoning gap probes", () => {
  it("buildReasoningGapProbePrompt requires structured JSON output and shared question rules", () => {
    const prompt = buildReasoningGapProbePrompt({
      currentTime: "2026-03-29T12:34:56.000Z",
      userQuery: "她适合找我聊这件事吗？",
      goalStatus: [createGoalStatus()],
      recalledAnchors: [createAnchor()],
    });

    const system = prompt.find((message) => message.role === "system")?.content ?? "";
    const user = prompt.find((message) => message.role === "user")?.content ?? "";

    expect(system).toContain("输出必须是 JSON");
    expect(system).toContain("最多输出 3 条");
    expect(system).toContain("question 必须使用“我”作为主语");
    expect(system).toContain("不得包含“这个”“那个”“刚才提到的”");
    expect(user).toContain("## User Query");
    expect(user).toContain("她适合找我聊这件事吗？");
    expect(user).toContain("relationship_boundary");
    expect(user).toContain("我和对方现在是什么关系");
    expect(user).toContain("我在这种关系里怎么设边界？");
  });

  it("creates 1-3 high-value probe drafts from missing goals", async () => {
    const probes = await synthesizeGapProbes({
      userQuery: "她适合找我聊这件事吗？",
      goalStatus: [createGoalStatus()],
      recalledAnchors: [],
      generateProbeDrafts: mockDrafts([
        { question: "用户和对方现在是什么关系？", kind: "fact-gap" },
        { question: "用户在这种关系里怎么设边界？", kind: "judgment-gap" },
        { question: "用户会优先找什么样的人聊这类事？", kind: "judgment-gap" },
        { question: "用户最近还在纠结什么？", kind: "fact-gap" },
      ]),
    });

    expect(probes).toHaveLength(3);
    expect(probes).toEqual([
      expect.objectContaining({
        displayQuestion: "我和对方现在是什么关系？",
        canonicalQuestion: "我和对方现在是什么关系？",
        kind: "fact-gap",
      }),
      expect.objectContaining({
        displayQuestion: "我最近在这种关系里怎么设边界？",
        canonicalQuestion: "我最近在这种关系里怎么设边界？",
        kind: "judgment-gap",
      }),
      expect.objectContaining({
        displayQuestion: "我会优先找什么样的人聊这类事？",
        canonicalQuestion: "我会优先找什么样的人聊这类事？",
        kind: "judgment-gap",
      }),
    ]);
  });

  it("classifies default fallback drafts per missing item instead of per goal", async () => {
    const probes = await synthesizeGapProbes({
      userQuery: "她适合找我聊这件事吗？",
      goalStatus: [createGoalStatus()],
      recalledAnchors: [],
    });

    expect(probes).toEqual([
      expect.objectContaining({
        displayQuestion: "我和对方现在是什么关系？",
        canonicalQuestion: "我和对方现在是什么关系？",
        kind: "fact-gap",
      }),
      expect.objectContaining({
        displayQuestion: "我通常在这种关系里怎么设边界？",
        canonicalQuestion: "我通常在这种关系里怎么设边界？",
        kind: "judgment-gap",
      }),
    ]);
  });

  it("infers judgment gaps from missing text when missingKeys are absent", async () => {
    const probes = await synthesizeGapProbes({
      userQuery: "她适合找我聊这件事吗？",
      goalStatus: [
        createGoalStatus({
          missing: ["我通常在这种关系里怎么设边界"],
          missingKeys: undefined,
        }),
      ],
      recalledAnchors: [],
    });

    expect(probes).toEqual([
      expect.objectContaining({
        displayQuestion: "我通常在这种关系里怎么设边界？",
        canonicalQuestion: "我通常在这种关系里怎么设边界？",
        kind: "judgment-gap",
      }),
    ]);
  });

  it("keeps factual relationship questions as fact gaps when missingKeys are absent", async () => {
    const probes = await synthesizeGapProbes({
      userQuery: "她适合找我聊这件事吗？",
      goalStatus: [
        createGoalStatus({
          missing: ["我和对方现在是什么关系"],
          missingKeys: undefined,
        }),
      ],
      recalledAnchors: [],
    });

    expect(probes).toEqual([
      expect.objectContaining({
        displayQuestion: "我和对方现在是什么关系？",
        canonicalQuestion: "我和对方现在是什么关系？",
        kind: "fact-gap",
      }),
    ]);
  });

  it("falls back to default drafts when the injected generator throws", async () => {
    const probes = await synthesizeGapProbes({
      userQuery: "她适合找我聊这件事吗？",
      goalStatus: [createGoalStatus({ missing: ["我和对方现在是什么关系"] })],
      recalledAnchors: [],
      generateProbeDrafts: vi.fn(async () => {
        throw new Error("generator failed");
      }),
    });

    expect(probes).toEqual([
      expect.objectContaining({
        displayQuestion: "我和对方现在是什么关系？",
        canonicalQuestion: "我和对方现在是什么关系？",
        kind: "fact-gap",
      }),
    ]);
  });

  it("drops a probe when the same canonical question is already answered in recalled anchors", async () => {
    const probes = await synthesizeGapProbes({
      userQuery: "我该怎么回复？",
      goalStatus: [createGoalStatus({ missing: ["我通常在这种关系里怎么设边界"] })],
      recalledAnchors: [createAnchor()],
      generateProbeDrafts: mockDrafts([
        { question: "用户在这种关系里怎么设边界？", kind: "judgment-gap" },
      ]),
    });

    expect(probes).toEqual([]);
  });

  it("keeps the probe when the recalled match is still unanswered", async () => {
    const probes = await synthesizeGapProbes({
      userQuery: "我该怎么回复？",
      goalStatus: [createGoalStatus({ missing: ["我通常在这种关系里怎么设边界"] })],
      recalledAnchors: [createAnchor({ id: "a2", answer: null, source: "reading" })],
      generateProbeDrafts: mockDrafts([
        { question: "用户在这种关系里怎么设边界？", kind: "judgment-gap" },
      ]),
    });

    expect(probes).toHaveLength(1);
    expect(probes[0]?.displayQuestion).toBe("我最近在这种关系里怎么设边界？");
  });

  it("creates only one probe when two drafts collapse to the same canonicalQuestion", async () => {
    const probes = await synthesizeGapProbes({
      userQuery: "我该怎么回复？",
      goalStatus: [createGoalStatus({ missing: ["我通常在这种关系里怎么设边界"] })],
      recalledAnchors: [],
      generateProbeDrafts: mockDrafts([
        { question: "用户在这种关系里怎么设边界？", kind: "judgment-gap" },
        { question: "我在这种关系里怎么设边界？", kind: "judgment-gap" },
      ]),
    });

    expect(probes).toHaveLength(1);
    expect(probes[0]?.canonicalQuestion).toBe("我最近在这种关系里怎么设边界？");
  });

  it("drops drafts that cannot be safely canonicalized", async () => {
    const probes = await synthesizeGapProbes({
      userQuery: "我该怎么回复？",
      goalStatus: [createGoalStatus({ missing: ["我刚才提到的那个项目里最重要的是什么"] })],
      recalledAnchors: [],
      generateProbeDrafts: mockDrafts([
        { question: "用户刚才提到的那个项目里最重要的是什么？", kind: "term-gap" },
      ]),
    });

    expect(probes).toEqual([]);
  });
});
