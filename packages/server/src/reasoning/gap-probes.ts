import type { SoulAnchor } from "../types.js";
import { canonicalizeQuestionDraft } from "./question-canonicalization.js";
import { buildReasoningGapProbePrompt, type ReasoningGoalStatus } from "./prompts.js";

export type ReasoningGapProbeKind = "fact-gap" | "judgment-gap" | "term-gap";

export interface ReasoningGapProbeDraft {
  question: string;
  kind: ReasoningGapProbeKind;
  sourceRef?: string | null;
  sourceSnapshot?: Record<string, unknown> | null;
}

export interface PendingReasoningProbe {
  displayQuestion: string;
  canonicalQuestion: string;
  kind: ReasoningGapProbeKind;
  sourceRef: string | null;
  sourceSnapshot: Record<string, unknown> | null;
}

export interface SynthesizeGapProbesInput {
  currentTime?: string;
  userQuery: string;
  goalStatus: ReasoningGoalStatus[];
  recalledAnchors: SoulAnchor[];
  generateProbeDrafts?: (input: {
    prompt: ReturnType<typeof buildReasoningGapProbePrompt>;
    userQuery: string;
    goalStatus: ReasoningGoalStatus[];
    recalledAnchors: SoulAnchor[];
  }) => Promise<ReasoningGapProbeDraft[]>;
}

function ensureQuestionMark(question: string): string {
  const trimmed = question.trim();
  if (!trimmed) {
    return trimmed;
  }

  return /[？?]$/.test(trimmed) ? trimmed : `${trimmed}？`;
}

function inferProbeKind(missing: string, missingKey?: string): ReasoningGapProbeKind {
  if (missingKey && /(style|preference|boundary|judgment|criteria)/i.test(missingKey)) {
    return "judgment-gap";
  }

  if (
    (missingKey && /(term|definition|meaning|name|title)/i.test(missingKey)) ||
    (!missingKey && /叫|术语|定义|意思|是什么/.test(missing))
  ) {
    return "term-gap";
  }

  return "fact-gap";
}

function createFallbackDrafts(goalStatus: ReasoningGoalStatus[]): ReasoningGapProbeDraft[] {
  return goalStatus
    .filter((status) => !status.sufficient)
    .flatMap((status) =>
      (status.missing ?? []).map((missing, index) => ({
        question: ensureQuestionMark(missing),
        kind: inferProbeKind(missing, status.missingKeys?.[index]),
        sourceRef: status.goalId,
        sourceSnapshot: { goalId: status.goalId, missingKeys: status.missingKeys ?? [] },
      })),
    );
}

function hasAnsweredCanonicalMatch(
  canonicalQuestion: string,
  recalledAnchors: SoulAnchor[],
): boolean {
  return recalledAnchors.some((anchor) => {
    if (anchor.answer == null || anchor.answer.trim().length === 0) {
      return false;
    }

    return (
      canonicalizeQuestionDraft({ draft: anchor.question, ownerVoice: "first-person" })
        .canonicalQuestion === canonicalQuestion
    );
  });
}

export async function synthesizeGapProbes(
  input: SynthesizeGapProbesInput,
): Promise<PendingReasoningProbe[]> {
  const prompt = buildReasoningGapProbePrompt({
    currentTime: input.currentTime ?? new Date(0).toISOString(),
    userQuery: input.userQuery,
    goalStatus: input.goalStatus,
    recalledAnchors: input.recalledAnchors,
  });

  let rawDrafts: ReasoningGapProbeDraft[];

  if (input.generateProbeDrafts) {
    try {
      rawDrafts = await input.generateProbeDrafts({
        prompt,
        userQuery: input.userQuery,
        goalStatus: input.goalStatus,
        recalledAnchors: input.recalledAnchors,
      });
    } catch {
      rawDrafts = createFallbackDrafts(input.goalStatus);
    }
  } else {
    rawDrafts = createFallbackDrafts(input.goalStatus);
  }

  const seenCanonicalQuestions = new Set<string>();
  const probes: PendingReasoningProbe[] = [];

  for (const draft of rawDrafts) {
    const normalized = canonicalizeQuestionDraft({
      draft: ensureQuestionMark(draft.question),
      ownerVoice: "first-person",
    });

    if (!normalized.canonicalQuestion) {
      continue;
    }

    if (seenCanonicalQuestions.has(normalized.canonicalQuestion)) {
      continue;
    }

    if (hasAnsweredCanonicalMatch(normalized.canonicalQuestion, input.recalledAnchors)) {
      continue;
    }

    seenCanonicalQuestions.add(normalized.canonicalQuestion);
    probes.push({
      displayQuestion: normalized.displayQuestion,
      canonicalQuestion: normalized.canonicalQuestion,
      kind: draft.kind,
      sourceRef: draft.sourceRef ?? null,
      sourceSnapshot: draft.sourceSnapshot ?? null,
    });

    if (probes.length === 3) {
      break;
    }
  }

  return probes;
}
