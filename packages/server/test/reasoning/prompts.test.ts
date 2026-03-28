import { describe, expect, it } from "vitest";
import type { SoulAnchor } from "../../src/types.js";
import {
  buildAvatarSystemPrompt,
  buildReasoningDecompositionPrompt,
  buildReasoningGenerationPrompt,
  buildReasoningJudgmentPrompt,
} from "../../src/reasoning/prompts.js";

function createAnchor(overrides: Partial<SoulAnchor> = {}): SoulAnchor {
  return {
    id: "a1",
    question: "我最近在忙什么？",
    answer: "最近在推进独立开发和路演准备",
    source: "interview",
    createdAt: Date.parse("2026-03-26T12:00:00.000Z"),
    updatedAt: Date.parse("2026-03-27T21:13:08.000Z"),
    ...overrides,
  };
}

describe("reasoning prompts", () => {
  it("buildReasoningDecompositionPrompt requires full JSON schema including userQuery and currentTime", () => {
    const messages = buildReasoningDecompositionPrompt({
      currentTime: "2026-03-28T12:34:56.000Z",
      userQuery: "我最近的工作重心是什么？",
    });

    const system = messages.find((message) => message.role === "system")?.content ?? "";
    const user = messages.find((message) => message.role === "user")?.content ?? "";

    expect(system).toContain("输出必须是 JSON");
    expect(system).toContain("userQuery");
    expect(system).toContain("currentTime");
    expect(system).toContain("answerGoals");
    expect(system).toContain("successCriteria");
    expect(user).toContain("## Raw User Query");
    expect(user).toContain("我最近的工作重心是什么？");
    expect(user).toContain('"userQuery": "我最近的工作重心是什么？"');
    expect(user).toContain('"currentTime": "2026-03-28T12:34:56.000Z"');
  });

  it("buildReasoningJudgmentPrompt requires detailed JSON contract and explicit visitor key", () => {
    const messages = buildReasoningJudgmentPrompt({
      currentTime: "2026-03-28T12:34:56.000Z",
      visitorKey: "visitor-pub-key",
      visitorContext: "caller notes: repeat visitor",
      goals: [
        { id: "domain_answer", goal: "找到回答当前问题所需的事实", required: true },
        { id: "temporal_validity", goal: "判断信息是否可能过时", required: false },
      ],
      anchors: [createAnchor()],
    });

    const system = messages.find((message) => message.role === "system")?.content ?? "";
    const user = messages.find((message) => message.role === "user")?.content ?? "";

    expect(system).toContain("输出必须是 JSON");
    expect(system).toContain("goalStatus");
    expect(system).toContain("goalId");
    expect(system).toContain("known");
    expect(system).toContain("missing");
    expect(system).toContain("knownAnchorIds");
    expect(system).toContain("missingKeys");
    expect(system).toContain("如果 sufficient 为 true");
    expect(system).not.toContain("<judgment>");
    expect(user).toContain("## Visitor Key");
    expect(user).toContain("visitor-pub-key");
    expect(user).toContain("## Visitor Context");
    expect(user).toContain("caller notes: repeat visitor");
    expect(user).toContain("UpdatedAt: 2026-03-27T21:13:08.000Z");
  });

  it("buildReasoningGenerationPrompt preserves required missing information and answering contract", () => {
    const prompt = buildReasoningGenerationPrompt({
      currentTime: "2026-03-28T12:34:56.000Z",
      userQuestion: "我最近的工作重心是什么？",
      answerGoals: [
        { id: "domain_answer", goal: "回答当前问题", required: true },
        { id: "temporal_validity", goal: "判断近期信息是否可靠", required: false },
      ],
      evidenceAnchors: [createAnchor()],
      goalStatus: [
        {
          goalId: "domain_answer",
          sufficient: true,
          known: ["已有近期工作重心锚点"],
          missing: [],
          knownAnchorIds: ["a1"],
          missingKeys: [],
        },
        {
          goalId: "domain_answer",
          sufficient: false,
          known: ["已有部分锚点"],
          missing: ["缺少更近期更新"],
          knownAnchorIds: ["a1"],
          missingKeys: ["recent-position"],
        },
      ],
      missingInformation: ["是否有更近的公开更新"],
      reasoningChain: ["已有锚点能部分回答，但近期性仍需保守处理"],
      temporalValiditySatisfied: false,
    });

    expect(prompt).toContain("## Current Time");
    expect(prompt).toContain("## User Question");
    expect(prompt).toContain("## Answer Goals");
    expect(prompt).toContain("## Evidence");
    expect(prompt).toContain("## Missing Information");
    expect(prompt).toContain("- 是否有更近的公开更新");
    expect(prompt).toContain("## Non-evidence Reasoning");
    expect(prompt).toContain("GoalId: domain_answer");
    expect(prompt).toContain("Missing: 缺少更近期更新");
    expect(prompt).toContain("MissingKeys: recent-position");
    expect(prompt).toContain("## Answering Rules");
    expect(prompt).toContain("UpdatedAt: 2026-03-27T21:13:08.000Z");
    expect(prompt).toContain("The reasoning chain is not factual evidence.");
    expect(prompt).toContain("基于目前已知锚点");
    expect(prompt).toContain("我目前只知道");
  });

  it("buildAvatarSystemPrompt delegates to the reasoning generation contract", () => {
    const prompt = buildAvatarSystemPrompt([createAnchor()]);

    expect(prompt).toContain("## Current Time");
    expect(prompt).toContain("## Evidence");
    expect(prompt).toContain("UpdatedAt: 2026-03-27T21:13:08.000Z");
    expect(prompt).toContain("## Missing Information");
    expect(prompt).toContain("## Non-evidence Reasoning");
  });
});
