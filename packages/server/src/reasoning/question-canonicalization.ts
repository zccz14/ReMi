export interface CanonicalizedQuestion {
  displayQuestion: string;
  canonicalQuestion: string;
}

export const OWNER_QUESTION_PROMPT_RULES = [
  "8. 凡是锚定本体的人格、认知、偏好、经历与事实，question 必须使用“我”作为主语，不得使用“用户”",
  "11. question 不得包含“这个”“那个”“刚才提到的”等依赖上下文才能解析的指代",
].join("\n");

function normalizeOwnerQuestionDraft(question: string): string {
  let normalized = question.trim();

  normalized = normalized.replace(/用户的/g, "我的");
  normalized = normalized.replace(/用户最近在/g, "我最近在");
  normalized = normalized.replace(/用户最近/g, "我最近");
  normalized = normalized.replace(/用户现在在/g, "我现在在");
  normalized = normalized.replace(/用户现在/g, "我现在");
  normalized = normalized.replace(/用户在/g, "我在");
  normalized = normalized.replace(/用户/g, "我");

  normalized = normalized.replace(/刚才提到的那个/g, "提到的");
  normalized = normalized.replace(/刚才提到的这个/g, "提到的");

  normalized = normalized.replace(
    /^我在(?:上周[一二三四五六日天]?|本周|这周|昨天|今天|刚才|当时|前天)?(?:上午|中午|下午|晚上)?/,
    "我最近在",
  );
  normalized = normalized.replace(/具体/g, "");
  normalized = normalized.replace(/经历了什么/g, "经历什么");
  normalized = normalized.replace(/我在经历什么/g, "我最近在经历什么");
  normalized = normalized.replace(/我在做什么/g, "我现在在做什么");
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized;
}

function collapseQuestionForExactMatch(question: string): string {
  return question.replace(/\s+/g, " ").trim();
}

export function canonicalizeQuestionDraft(input: {
  draft: string;
  ownerVoice: "first-person";
}): CanonicalizedQuestion {
  const displayQuestion = normalizeOwnerQuestionDraft(input.draft);

  return {
    displayQuestion,
    canonicalQuestion: collapseQuestionForExactMatch(displayQuestion),
  };
}
