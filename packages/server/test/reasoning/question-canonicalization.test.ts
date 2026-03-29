import { describe, expect, it } from "vitest";
import { canonicalizeQuestionDraft } from "../../src/reasoning/question-canonicalization.js";

describe("canonicalizeQuestionDraft", () => {
  it("does not emit a stable canonicalQuestion for context-dependent references", () => {
    const result = canonicalizeQuestionDraft({
      draft: "用户刚才提到的那个项目里最重要的是什么？",
      ownerVoice: "first-person",
    });

    expect(result.displayQuestion).toBe("我刚才提到的那个项目里最重要的是什么？");
    expect(result.canonicalQuestion).toBeNull();
  });

  it("keeps a stable canonicalQuestion for self-contained owner questions", () => {
    const result = canonicalizeQuestionDraft({
      draft: "用户的决策偏好是什么样的？",
      ownerVoice: "first-person",
    });

    expect(result.displayQuestion).toBe("我的决策偏好是什么样的？");
    expect(result.canonicalQuestion).toBe("我的决策偏好是什么样的？");
  });
});
