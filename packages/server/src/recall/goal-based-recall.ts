import type { ChatClient, ChatMessage } from "../llm/client.js";
import type { EmbeddingClient } from "../embedding/client.js";
import type { SoulAnchor } from "../types.js";
import {
  RECALL_FULL_INJECTION_THRESHOLD,
  RECALL_MISSING_KEYS,
  RECALL_STOP_REASONS,
  type RecallMissingKey,
  type RecallStopReason,
} from "./constants.js";

type ParsedGoalStatus = {
  goalId?: unknown;
  sufficient?: unknown;
  knownAnchorIds?: unknown;
  missingKeys?: unknown;
  known?: unknown;
  missing?: unknown;
};

export type GoalStatus = {
  goalId: string;
  sufficient: boolean;
  knownAnchorIds: string[];
  missingKeys: RecallMissingKey[];
  known?: string[];
  missing?: string[];
};

export type RecallRoundSummary = {
  round: number;
  query: string;
  newAnchorIds: string[];
  allAnchorIds: string[];
  normalizedGoalStatus: GoalStatus[];
  stoppedCandidate?: RecallStopReason;
};

type ParsedJudgment = {
  sufficient?: boolean;
  nextQuery?: string;
  narrative?: string;
  goalStatus?: ParsedGoalStatus[];
};

export interface GoalBasedRecallOptions {
  chatClient: ChatClient;
  embeddingClient?: EmbeddingClient;
  goals: string[];
  context: string;
  initialAnchors?: SoulAnchor[];
  countAnchors(): Promise<number>;
  listAnchors(limit?: number): Promise<SoulAnchor[]>;
  searchAnchors(embedding: number[]): Promise<SoulAnchor[]>;
  buildJudgmentPrompt(args: {
    goals: string[];
    anchors: SoulAnchor[];
    context: string;
  }): ChatMessage[];
  parseJudgment(content: string): ParsedJudgment;
  onNarrative?: (text: string) => void;
  maxRounds?: number;
}

export interface GoalBasedRecallResult {
  anchors: SoulAnchor[];
  narratives: string[];
  rounds: number;
  sufficient: boolean;
  strategy: "full-injection" | "recall-loop";
  goalStatus: GoalStatus[];
  stoppedBecause: RecallStopReason;
  roundSummaries: RecallRoundSummary[];
}

const RECALL_MISSING_KEY_SET = new Set<string>(RECALL_MISSING_KEYS);

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);

  return items.length > 0 ? Array.from(new Set(items)) : [];
}

function normalizeMissingKeys(value: unknown): RecallMissingKey[] {
  const keys = normalizeStringArray(value) ?? [];
  if (keys.length === 0) {
    return [];
  }

  return Array.from(
    new Set(
      keys.map((key) =>
        RECALL_MISSING_KEY_SET.has(key) ? (key as RecallMissingKey) : ("other" as RecallMissingKey),
      ),
    ),
  );
}

function normalizeGoalStatuses(
  parsedStatus: ParsedGoalStatus[] | undefined,
  requiredGoals: string[],
): GoalStatus[] {
  const normalizedByGoal = new Map<string, GoalStatus>();

  for (const entry of parsedStatus ?? []) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const goalId = typeof entry.goalId === "string" ? entry.goalId.trim() : "";
    if (!goalId) {
      continue;
    }

    normalizedByGoal.set(goalId, {
      goalId,
      sufficient: entry.sufficient === true && normalizeMissingKeys(entry.missingKeys).length === 0,
      knownAnchorIds: normalizeStringArray(entry.knownAnchorIds) ?? [],
      missingKeys: normalizeMissingKeys(entry.missingKeys),
      known: normalizeStringArray(entry.known),
      missing: normalizeStringArray(entry.missing),
    });
  }

  for (const goalId of requiredGoals) {
    if (!normalizedByGoal.has(goalId)) {
      normalizedByGoal.set(goalId, {
        goalId,
        sufficient: false,
        knownAnchorIds: [],
        missingKeys: ["unassessed-required-goal"],
      });
    }
  }

  const requiredGoalSet = new Set(requiredGoals);
  const orderedStatuses: GoalStatus[] = [];

  for (const goalId of requiredGoals) {
    const status = normalizedByGoal.get(goalId);
    if (status) {
      orderedStatuses.push(status);
    }
  }

  for (const [goalId, status] of normalizedByGoal.entries()) {
    if (!requiredGoalSet.has(goalId)) {
      orderedStatuses.push(status);
    }
  }

  return orderedStatuses;
}

function computeOverallSufficient(statuses: GoalStatus[], requiredGoals: string[]): boolean {
  const statusByGoal = new Map(statuses.map((status) => [status.goalId, status]));
  return requiredGoals.every((goalId) => {
    const status = statusByGoal.get(goalId);
    return Boolean(status && status.sufficient && status.missingKeys.length === 0);
  });
}

function getRequiredMissingSignature(statuses: GoalStatus[], requiredGoals: string[]): string {
  const requiredGoalSet = new Set(requiredGoals);
  return JSON.stringify(
    statuses
      .filter((status) => requiredGoalSet.has(status.goalId))
      .map((status) => ({
        goalId: status.goalId,
        missingKeys: [...status.missingKeys].sort(),
      }))
      .sort((left, right) => left.goalId.localeCompare(right.goalId)),
  );
}

function getNewAnchorIds(
  foundAnchors: SoulAnchor[],
  allAnchors: Map<string, SoulAnchor>,
): string[] {
  const newAnchorIds: string[] = [];
  for (const anchor of foundAnchors) {
    if (!allAnchors.has(anchor.id)) {
      newAnchorIds.push(anchor.id);
    }
  }
  return newAnchorIds;
}

function isEmptyNextQuery(nextQuery: string | undefined, currentQuery: string): boolean {
  if (!nextQuery) {
    return true;
  }

  if (nextQuery === currentQuery) {
    return true;
  }

  return nextQuery.trim() === currentQuery.trim();
}

async function getJudgmentWithRetry(
  options: GoalBasedRecallOptions,
  anchors: SoulAnchor[],
): Promise<{ judgment?: ParsedJudgment; narrative?: string; failed: boolean }> {
  const messages = options.buildJudgmentPrompt({
    goals: options.goals,
    anchors,
    context: options.context,
  });

  let parseFailures = 0;

  while (parseFailures < 2) {
    const response = await options.chatClient.chat({ messages });

    try {
      const judgment = options.parseJudgment(response.content);
      return { judgment, narrative: judgment.narrative, failed: false };
    } catch {
      parseFailures += 1;
    }
  }

  return { failed: true };
}

export async function goalBasedRecall(
  options: GoalBasedRecallOptions,
): Promise<GoalBasedRecallResult> {
  const anchorCount = await options.countAnchors();

  if (anchorCount <= RECALL_FULL_INJECTION_THRESHOLD) {
    const anchors = await options.listAnchors();
    return {
      anchors,
      narratives: [],
      rounds: 0,
      sufficient: true,
      strategy: "full-injection",
      goalStatus: options.goals.map((goalId) => ({
        goalId,
        sufficient: true,
        knownAnchorIds: anchors.map((anchor) => anchor.id),
        missingKeys: [],
      })),
      stoppedBecause: RECALL_STOP_REASONS.SUFFICIENT,
      roundSummaries: [],
    };
  }

  if (!options.embeddingClient) {
    throw new Error("Embedding client not configured for recall loop");
  }

  const allAnchors = new Map<string, SoulAnchor>();
  for (const anchor of options.initialAnchors ?? []) {
    allAnchors.set(anchor.id, anchor);
  }

  const narratives: string[] = [];
  const roundSummaries: RecallRoundSummary[] = [];
  const maxRounds = options.maxRounds ?? 5;

  let query = options.context;
  let rounds = 0;
  let previousMissingSignature: string | undefined;
  let lastGoalStatus = normalizeGoalStatuses(undefined, options.goals);

  while (rounds < maxRounds) {
    rounds += 1;

    const [embedding] = await options.embeddingClient.embed([query]);
    const foundAnchors = await options.searchAnchors(embedding);
    const newAnchorIds = getNewAnchorIds(foundAnchors, allAnchors);
    for (const anchor of foundAnchors) {
      allAnchors.set(anchor.id, anchor);
    }

    const judgmentResult = await getJudgmentWithRetry(options, Array.from(allAnchors.values()));
    if (judgmentResult.failed || !judgmentResult.judgment) {
      roundSummaries.push({
        round: rounds,
        query,
        newAnchorIds,
        allAnchorIds: Array.from(allAnchors.keys()),
        normalizedGoalStatus: lastGoalStatus,
        stoppedCandidate: RECALL_STOP_REASONS.PARSE_FAILURE,
      });
      return {
        anchors: Array.from(allAnchors.values()),
        narratives,
        rounds,
        sufficient: false,
        strategy: "recall-loop",
        goalStatus: lastGoalStatus,
        stoppedBecause: RECALL_STOP_REASONS.PARSE_FAILURE,
        roundSummaries,
      };
    }

    if (judgmentResult.narrative) {
      narratives.push(judgmentResult.narrative);
      options.onNarrative?.(judgmentResult.narrative);
    }

    const goalStatus = normalizeGoalStatuses(judgmentResult.judgment.goalStatus, options.goals);
    lastGoalStatus = goalStatus;
    const sufficient = computeOverallSufficient(goalStatus, options.goals);
    const missingSignature = getRequiredMissingSignature(goalStatus, options.goals);

    let stoppedCandidate: RecallStopReason | undefined;
    if (sufficient) {
      stoppedCandidate = RECALL_STOP_REASONS.SUFFICIENT;
    } else if (newAnchorIds.length === 0) {
      stoppedCandidate = RECALL_STOP_REASONS.NO_NEW_ANCHORS;
    } else if (
      previousMissingSignature !== undefined &&
      missingSignature === previousMissingSignature
    ) {
      stoppedCandidate = RECALL_STOP_REASONS.NO_MISSING_REDUCED;
    } else if (isEmptyNextQuery(judgmentResult.judgment.nextQuery, query)) {
      stoppedCandidate = RECALL_STOP_REASONS.EMPTY_NEXT_QUERY;
    }

    roundSummaries.push({
      round: rounds,
      query,
      newAnchorIds,
      allAnchorIds: Array.from(allAnchors.keys()),
      normalizedGoalStatus: goalStatus,
      stoppedCandidate,
    });

    if (stoppedCandidate) {
      return {
        anchors: Array.from(allAnchors.values()),
        narratives,
        rounds,
        sufficient,
        strategy: "recall-loop",
        goalStatus,
        stoppedBecause: stoppedCandidate,
        roundSummaries,
      };
    }

    previousMissingSignature = missingSignature;
    query = judgmentResult.judgment.nextQuery ?? query;
  }

  return {
    anchors: Array.from(allAnchors.values()),
    narratives,
    rounds,
    sufficient: computeOverallSufficient(lastGoalStatus, options.goals),
    strategy: "recall-loop",
    goalStatus: lastGoalStatus,
    stoppedBecause: RECALL_STOP_REASONS.MAX_ROUNDS,
    roundSummaries,
  };
}
