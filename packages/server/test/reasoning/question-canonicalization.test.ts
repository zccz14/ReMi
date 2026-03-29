import { describe, expect, it } from "vitest";
import { canonicalizeQuestionDraft } from "../../src/reasoning/question-canonicalization.js";

describe("canonicalizeQuestionDraft", () => {
  it("returns displayQuestion and canonicalQuestion from the same draft", () => {
    const result = canonicalizeQuestionDraft({
      draft: "用户刚才提到的那个项目里最重要的是什么？",
      ownerVoice: "first-person",
    });

    expect(result.displayQuestion).toContain("我");
    expect(result.canonicalQuestion).toBe("我提到的项目里最重要的是什么？");
  });

  it("keeps interview and reasoning canonicalQuestion aligned", () => {
    const interview = canonicalizeQuestionDraft({
      draft: "用户的决策偏好是什么样的？",
      ownerVoice: "first-person",
    });
    const reasoning = canonicalizeQuestionDraft({
      draft: "用户的决策偏好是什么样的？",
      ownerVoice: "first-person",
    });

    expect(interview.canonicalQuestion).toBe(reasoning.canonicalQuestion);
  });
});
