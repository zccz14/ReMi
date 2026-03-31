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

export interface ReasoningProbeSynthesisStats {
  rawDraftCount: number;
  droppedCount: number;
}

export interface SynthesizedGapProbes {
  probes: PendingReasoningProbe[];
  stats: ReasoningProbeSynthesisStats;
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
  shouldRethrowGenerateProbeDraftError?: (error: unknown) => boolean;
}

function unwrapJsonCodeFence(content: string): string {
  const trimmed = content.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return fencedMatch?.[1]?.trim() ?? trimmed;
}

function isReasoningGapProbeKind(value: unknown): value is ReasoningGapProbeKind {
  return value === "fact-gap" || value === "judgment-gap" || value === "term-gap";
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
    !missingKey &&
    /(怎么|如何|会不会|是否应该|更看重|设边界|判断标准|偏好|原则|适合|该不该)/.test(missing)
  ) {
    return "judgment-gap";
  }

  if (!missingKey && /(是什么关系|关系是什么)/.test(missing)) {
    return "fact-gap";
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

export function parseReasoningGapProbeDrafts(content: string): ReasoningGapProbeDraft[] {
  const parsed = JSON.parse(unwrapJsonCodeFence(content)) as { probes?: unknown };

  if (!Array.isArray(parsed.probes)) {
    throw new Error("Probe draft response must contain a probes array");
  }

  return parsed.probes.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const record = item as Record<string, unknown>;
    if (typeof record.question !== "string" || !record.question.trim()) {
      return [];
    }
    if (!isReasoningGapProbeKind(record.kind)) {
      return [];
    }

    return [
      {
        question: record.question.trim(),
        kind: record.kind,
        sourceRef: typeof record.sourceRef === "string" ? record.sourceRef : null,
        sourceSnapshot:
          record.sourceSnapshot && typeof record.sourceSnapshot === "object"
            ? (record.sourceSnapshot as Record<string, unknown>)
            : null,
      } satisfies ReasoningGapProbeDraft,
    ];
  });
}

export async function synthesizeGapProbes(
  input: SynthesizeGapProbesInput,
): Promise<SynthesizedGapProbes> {
  const fallbackDrafts = createFallbackDrafts(input.goalStatus);
  if (fallbackDrafts.length === 0) {
    return {
      probes: [],
      stats: {
        rawDraftCount: 0,
        droppedCount: 0,
      },
    };
  }

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
    } catch (error) {
      if (input.shouldRethrowGenerateProbeDraftError?.(error)) {
        throw error;
      }
      rawDrafts = fallbackDrafts;
    }
  } else {
    rawDrafts = fallbackDrafts;
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

  return {
    probes,
    stats: {
      rawDraftCount: rawDrafts.length,
      droppedCount: Math.max(0, rawDrafts.length - probes.length),
    },
  };
}
