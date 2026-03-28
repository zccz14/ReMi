import type { ReasoningAnswerGoal } from "./prompts.js";

const DEFAULT_GOALS = [
  "我是谁，我的身份和表达风格",
  "对方是谁，我与对方的关系和沟通边界",
  "回答提问者的问题所需的认知",
];

const TEMPORAL_QUERY_PATTERN = /(最近|现在|目前|近期|变化|当前|latest|recent|current|now)/i;

export type ParsedDecomposition = {
  userQuery: string;
  currentTime: string;
  answerGoals: ReasoningAnswerGoal[];
};

export type ParsedJudgmentResult = {
  valid: boolean;
  judgment: {
    sufficient?: boolean;
    nextQuery?: string;
    narrative?: string;
    goalStatus?: Array<Record<string, unknown>>;
  };
  reasoningChain?: string[];
};

function isValidGoalStatusEntry(entry: unknown): entry is Record<string, unknown> {
  if (!entry || typeof entry !== "object") {
    return false;
  }

  const record = entry as Record<string, unknown>;

  if (typeof record.goalId !== "string" || !record.goalId.trim()) {
    return false;
  }

  if (record.sufficient !== undefined && typeof record.sufficient !== "boolean") {
    return false;
  }

  for (const key of ["known", "missing", "knownAnchorIds", "missingKeys"] as const) {
    const value = record[key];
    if (value !== undefined && !Array.isArray(value)) {
      return false;
    }
  }

  return true;
}

export function buildDefaultAnswerGoals(content: string): ReasoningAnswerGoal[] {
  const goals: ReasoningAnswerGoal[] = [
    {
      id: "identity_style",
      goal: DEFAULT_GOALS[0],
      required: true,
    },
    {
      id: "relationship_boundary",
      goal: DEFAULT_GOALS[1],
      required: true,
    },
    {
      id: "domain_answer",
      goal: DEFAULT_GOALS[2],
      required: true,
    },
  ];

  if (TEMPORAL_QUERY_PATTERN.test(content)) {
    goals.push({
      id: "temporal_validity",
      goal: "判断回答依赖的信息是否受时间影响、是否可能过期",
      required: true,
    });
  }

  return goals;
}

export function parseDecomposition(
  content: string,
  fallbackQuery: string,
  currentTime: string,
): ParsedDecomposition {
  const fallbackAnswerGoals = buildDefaultAnswerGoals(fallbackQuery);
  const fallback: ParsedDecomposition = {
    userQuery: fallbackQuery,
    currentTime,
    answerGoals: fallbackAnswerGoals,
  };

  const parsed = JSON.parse(content) as {
    answerGoals?: unknown;
  };

  if (!Array.isArray(parsed.answerGoals)) {
    return fallback;
  }

  const answerGoals = parsed.answerGoals
    .filter((entry): entry is ReasoningAnswerGoal => {
      if (!entry || typeof entry !== "object") {
        return false;
      }

      const record = entry as Record<string, unknown>;
      return (
        typeof record.id === "string" &&
        record.id.trim().length > 0 &&
        typeof record.goal === "string" &&
        record.goal.trim().length > 0 &&
        typeof record.required === "boolean"
      );
    })
    .map((goal) => ({
      id: goal.id.trim(),
      goal: goal.goal.trim(),
      required: goal.required,
    }));

  if (answerGoals.length === 0) {
    return fallback;
  }

  const requiredGoalIds = new Set(
    answerGoals.filter((goal) => goal.required).map((goal) => goal.id),
  );
  const expectedRequiredGoalIds = new Set(
    fallbackAnswerGoals.filter((goal) => goal.required).map((goal) => goal.id),
  );
  const hasExpectedRequiredGoals =
    requiredGoalIds.size === expectedRequiredGoalIds.size &&
    Array.from(expectedRequiredGoalIds).every((goalId) => requiredGoalIds.has(goalId));

  if (!hasExpectedRequiredGoals) {
    return fallback;
  }

  return {
    userQuery: fallback.userQuery,
    currentTime: fallback.currentTime,
    answerGoals,
  };
}

export function parseRecallJudgment(content: string): ParsedJudgmentResult {
  const parsed = JSON.parse(content) as {
    sufficient?: unknown;
    nextQuery?: unknown;
    narrative?: unknown;
    goalStatus?: unknown[];
    reasoningChain?: unknown;
  };

  const goalStatus = Array.isArray(parsed.goalStatus)
    ? parsed.goalStatus.filter(
        (item): item is Record<string, unknown> => !!item && typeof item === "object",
      )
    : undefined;
  const reasoningChain = Array.isArray(parsed.reasoningChain)
    ? parsed.reasoningChain.filter((item): item is string => typeof item === "string")
    : undefined;
  const valid =
    (parsed.sufficient === undefined || typeof parsed.sufficient === "boolean") &&
    (parsed.nextQuery === undefined || typeof parsed.nextQuery === "string") &&
    (parsed.narrative === undefined || typeof parsed.narrative === "string") &&
    (parsed.goalStatus === undefined ||
      (goalStatus !== undefined && goalStatus.every((entry) => isValidGoalStatusEntry(entry))));

  return {
    valid,
    judgment: {
      sufficient: typeof parsed.sufficient === "boolean" ? parsed.sufficient : undefined,
      nextQuery: typeof parsed.nextQuery === "string" ? parsed.nextQuery : undefined,
      narrative: typeof parsed.narrative === "string" ? parsed.narrative : undefined,
      goalStatus,
    },
    reasoningChain: valid ? reasoningChain : undefined,
  };
}

export function collectMissingInformation(
  goalStatus: Array<{ sufficient: boolean; missing?: string[]; missingKeys?: string[] }>,
): string[] {
  const missing = goalStatus.flatMap((status) => {
    if (status.sufficient) {
      return [];
    }

    if (status.missing?.length) {
      return status.missing;
    }

    return status.missingKeys ?? [];
  });

  return Array.from(new Set(missing.filter(Boolean)));
}
