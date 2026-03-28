import { describe, expect, it } from "vitest";
import type { SoulAnchor } from "../../src/types.js";
import {
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
  it("buildReasoningDecompositionPrompt includes currentTime, raw query, and JSON contract", () => {
    const messages = buildReasoningDecompositionPrompt({
      currentTime: "2026-03-28T12:34:56.000Z",
      userQuery: "我最近的工作重心是什么？",
    });

    const text = messages.map((message) => message.content).join("\n");

    expect(text).toContain("2026-03-28T12:34:56.000Z");
    expect(text).toContain("我最近的工作重心是什么？");
    expect(text).toContain("JSON");
    expect(text).toContain("answerGoals");
    expect(text).toContain("successCriteria");
  });

  it("buildReasoningJudgmentPrompt uses JSON and includes goals, anchors, currentTime, and visitor context", () => {
    const messages = buildReasoningJudgmentPrompt({
      currentTime: "2026-03-28T12:34:56.000Z",
      visitorContext: "visitorKey: visitor-pub-key",
      goals: [
        { id: "domain_answer", goal: "找到回答当前问题所需的事实", required: true },
        { id: "temporal_validity", goal: "判断信息是否可能过时", required: false },
      ],
      anchors: [createAnchor()],
    });

    const text = messages.map((message) => message.content).join("\n");

    expect(text).toContain("JSON");
    expect(text).not.toContain("<judgment>");
    expect(text).toContain("domain_answer");
    expect(text).toContain("temporal_validity");
    expect(text).toContain("visitor-pub-key");
    expect(text).toContain("我最近在忙什么？");
    expect(text).toContain("UpdatedAt: 2026-03-27T21:13:08.000Z");
  });

  it("buildReasoningGenerationPrompt renders required sections and evidence/update contract", () => {
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
    expect(prompt).toContain("## Non-evidence Reasoning");
    expect(prompt).toContain("## Answering Rules");
    expect(prompt).toContain("UpdatedAt: 2026-03-27T21:13:08.000Z");
    expect(prompt).toContain("reasoning chain is not factual evidence");
    expect(prompt).toContain("基于目前已知锚点");
    expect(prompt).toContain("我目前只知道");
  });
});
