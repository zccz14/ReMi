export const READING_MIN_LENGTH_HINT = 800;
export const READING_MAX_LENGTH = 50_000;
export const READING_ROUND_MAX_ITEMS = 18;
export const READING_THEME_MAX_ITEMS = 6;
export const READING_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const READING_SESSION_STORAGE_KEY = "remi-reading-session";

export type ReadingLocale = "zh" | "en";

export type ReadingSelection = "approved" | "question_invalid" | "answer_invalid" | null;

export interface ReadingCandidate {
  id: string;
  question: string;
  answer: string;
  themeId: string;
  themeLabel: string;
  score: number;
  sourceSnippet?: string;
  origin?: "new" | "review";
  reviewHint?: string;
}

export interface ReadingRoundItem extends ReadingCandidate {
  selection: ReadingSelection;
  correctionHint: string;
  isSourceOpen?: boolean;
}

export interface ReadingSummaryState {
  coveredTopics: string[];
  missingTopics: string[];
  selectedMissingTopics: string[];
  extraFocus: string;
  invalidQuestions: string[];
  shouldSuggestStop?: boolean;
}

export interface SubmittedReadingRound {
  roundIndex: number;
  approvedIds: string[];
  questionInvalidIds: string[];
  answerInvalidIds: string[];
}

export interface ApprovedReadingAnchor {
  id: string;
  question: string;
  answer: string;
  themeId: string;
  themeLabel: string;
}

export interface ReadingSession {
  locale: ReadingLocale;
  status: "active" | "closed";
  stage: "questionnaire" | "summary" | "closed";
  text: string;
  createdAt: number;
  updatedAt: number;
  currentRound: {
    index: number;
    items: ReadingRoundItem[];
  };
  invalidQuestions: string[];
  candidatePool: ReadingCandidate[];
  reviewQueue: ReadingCandidate[];
  approvedAnchors: ApprovedReadingAnchor[];
  submittedRounds: SubmittedReadingRound[];
  summary: ReadingSummaryState | null;
}

export interface ComposeNextRoundInput {
  approvedAnchors: ApprovedReadingAnchor[];
  reviewQueue: ReadingCandidate[];
  candidatePool: ReadingCandidate[];
  maxItems?: number;
  maxPerTheme?: number;
}

export interface ComposeNextRoundResult {
  items: ReadingCandidate[];
  deferredReviewQueue: ReadingCandidate[];
  deferredCandidatePool: ReadingCandidate[];
}

export interface SplitRoundResult {
  approved: ReadingRoundItem[];
  questionInvalid: ReadingRoundItem[];
  answerInvalid: ReadingRoundItem[];
}

export function countReadingChars(text: string) {
  return text.length;
}

export function getReadingLengthState(text: string) {
  const count = countReadingChars(text);
  return {
    count,
    isShort: count > 0 && count < READING_MIN_LENGTH_HINT,
    isTooLong: count > READING_MAX_LENGTH,
  };
}

function normalizeText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function questionKey(candidate: Pick<ReadingCandidate, "question">) {
  return normalizeText(candidate.question);
}

function candidateKey(candidate: Pick<ReadingCandidate, "question" | "answer">) {
  return `${questionKey(candidate)}::${normalizeText(candidate.answer)}`;
}

function makeRoundItem(candidate: ReadingCandidate): ReadingRoundItem {
  return {
    ...candidate,
    origin: candidate.origin ?? "new",
    selection: null,
    correctionHint: "",
    isSourceOpen: false,
  };
}

function dedupeCandidates(
  candidates: ReadingCandidate[],
  approvedAnchors: ApprovedReadingAnchor[],
  seenKeys: Set<string> = new Set<string>(),
): ReadingCandidate[] {
  const approvedKeys = new Set(
    approvedAnchors.flatMap((anchor) => [candidateKey(anchor), questionKey(anchor)]),
  );
  const unique: ReadingCandidate[] = [];

  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const qKey = questionKey(candidate);
    if (
      approvedKeys.has(key) ||
      approvedKeys.has(qKey) ||
      seenKeys.has(key) ||
      seenKeys.has(qKey)
    ) {
      continue;
    }
    seenKeys.add(key);
    seenKeys.add(qKey);
    unique.push(candidate);
  }

  return unique;
}

export function composeNextRound({
  approvedAnchors,
  reviewQueue,
  candidatePool,
  maxItems = READING_ROUND_MAX_ITEMS,
  maxPerTheme = READING_THEME_MAX_ITEMS,
}: ComposeNextRoundInput): ComposeNextRoundResult {
  const themeCounts = new Map<string, number>();
  const seenKeys = new Set<string>();
  const review = dedupeCandidates(
    reviewQueue.map((item) => ({ ...item, origin: "review" })),
    approvedAnchors,
    seenKeys,
  );
  const candidates = dedupeCandidates(
    [...candidatePool]
      .sort((a, b) => b.score - a.score)
      .map((item) => ({ ...item, origin: item.origin ?? "new" })),
    approvedAnchors,
    seenKeys,
  );

  const items: ReadingCandidate[] = [];
  const deferredReviewQueue: ReadingCandidate[] = [];
  const deferredCandidatePool: ReadingCandidate[] = [];

  const pushIfAllowed = (candidate: ReadingCandidate, deferredTarget: ReadingCandidate[]) => {
    const count = themeCounts.get(candidate.themeId) ?? 0;
    if (items.length >= maxItems || count >= maxPerTheme) {
      deferredTarget.push(candidate);
      return;
    }

    themeCounts.set(candidate.themeId, count + 1);
    items.push(candidate);
  };

  for (const candidate of review) {
    pushIfAllowed(candidate, deferredReviewQueue);
  }

  for (const candidate of candidates) {
    pushIfAllowed(candidate, deferredCandidatePool);
  }

  return {
    items,
    deferredReviewQueue,
    deferredCandidatePool,
  };
}

export function splitRoundItems(items: ReadingRoundItem[]): SplitRoundResult {
  return items.reduce<SplitRoundResult>(
    (acc, item) => {
      if (item.selection === "approved") {
        acc.approved.push(item);
      } else if (item.selection === "question_invalid") {
        acc.questionInvalid.push(item);
      } else if (item.selection === "answer_invalid") {
        acc.answerInvalid.push(item);
      }
      return acc;
    },
    { approved: [], questionInvalid: [], answerInvalid: [] },
  );
}

export function hasAnsweredAllItems(items: ReadingRoundItem[]) {
  return items.length > 0 && items.every((item) => item.selection !== null);
}

export function hasCompletedFeedback(items: ReadingRoundItem[]) {
  return (
    items.length > 0 &&
    items.every(
      (item) =>
        item.selection !== null &&
        (item.selection !== "answer_invalid" || item.correctionHint.trim().length > 0),
    )
  );
}

export function countAnsweredItems(items: ReadingRoundItem[]) {
  return items.filter((item) => item.selection !== null).length;
}

export function buildSessionFromCandidates(
  locale: ReadingLocale,
  text: string,
  candidates: ReadingCandidate[],
  now = Date.now(),
) {
  const composed = composeNextRound({
    approvedAnchors: [],
    reviewQueue: [],
    candidatePool: candidates,
  });

  return {
    locale,
    status: "active",
    stage: "questionnaire",
    text,
    createdAt: now,
    updatedAt: now,
    currentRound: {
      index: 1,
      items: composed.items.map(makeRoundItem),
    },
    invalidQuestions: [],
    candidatePool: composed.deferredCandidatePool,
    reviewQueue: composed.deferredReviewQueue,
    approvedAnchors: [],
    submittedRounds: [],
    summary: null,
  } satisfies ReadingSession;
}

function isReadingCandidate(value: unknown): value is ReadingCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.question === "string" &&
    typeof candidate.answer === "string" &&
    typeof candidate.themeId === "string" &&
    typeof candidate.themeLabel === "string" &&
    typeof candidate.score === "number"
  );
}

function isReadingRoundItem(value: unknown): value is ReadingRoundItem {
  if (!isReadingCandidate(value)) return false;
  const item = value as unknown as Record<string, unknown>;
  return (
    (item.selection === null ||
      item.selection === "approved" ||
      item.selection === "question_invalid" ||
      item.selection === "answer_invalid") &&
    typeof item.correctionHint === "string"
  );
}

function isApprovedAnchor(value: unknown): value is ApprovedReadingAnchor {
  if (!value || typeof value !== "object") return false;
  const anchor = value as Record<string, unknown>;
  return (
    typeof anchor.id === "string" &&
    typeof anchor.question === "string" &&
    typeof anchor.answer === "string" &&
    typeof anchor.themeId === "string" &&
    typeof anchor.themeLabel === "string"
  );
}

function isSummaryState(value: unknown): value is ReadingSummaryState {
  if (!value || typeof value !== "object") return false;
  const summary = value as Record<string, unknown>;
  return (
    Array.isArray(summary.coveredTopics) &&
    summary.coveredTopics.every((item) => typeof item === "string") &&
    Array.isArray(summary.missingTopics) &&
    summary.missingTopics.every((item) => typeof item === "string") &&
    Array.isArray(summary.selectedMissingTopics) &&
    summary.selectedMissingTopics.every((item) => typeof item === "string") &&
    Array.isArray(summary.invalidQuestions) &&
    summary.invalidQuestions.every((item) => typeof item === "string") &&
    typeof summary.extraFocus === "string" &&
    (summary.shouldSuggestStop === undefined || typeof summary.shouldSuggestStop === "boolean")
  );
}

function isSubmittedRound(value: unknown): value is SubmittedReadingRound {
  if (!value || typeof value !== "object") return false;
  const round = value as Record<string, unknown>;
  return (
    typeof round.roundIndex === "number" &&
    Array.isArray(round.approvedIds) &&
    round.approvedIds.every((item) => typeof item === "string") &&
    Array.isArray(round.questionInvalidIds) &&
    round.questionInvalidIds.every((item) => typeof item === "string") &&
    Array.isArray(round.answerInvalidIds) &&
    round.answerInvalidIds.every((item) => typeof item === "string")
  );
}

export function restoreReadingSession(raw: string | null, now = Date.now()): ReadingSession | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<ReadingSession>;
    if (
      !parsed ||
      (parsed.locale !== "zh" && parsed.locale !== "en") ||
      typeof parsed.text !== "string" ||
      typeof parsed.createdAt !== "number" ||
      typeof parsed.updatedAt !== "number" ||
      !parsed.currentRound ||
      typeof parsed.currentRound.index !== "number" ||
      !Array.isArray(parsed.currentRound.items) ||
      !Array.isArray(parsed.invalidQuestions) ||
      !Array.isArray(parsed.candidatePool) ||
      !Array.isArray(parsed.reviewQueue) ||
      !Array.isArray(parsed.approvedAnchors) ||
      !Array.isArray(parsed.submittedRounds) ||
      (parsed.status !== "active" && parsed.status !== "closed") ||
      (parsed.stage !== "questionnaire" && parsed.stage !== "summary" && parsed.stage !== "closed")
    ) {
      return null;
    }

    if (now - parsed.updatedAt > READING_SESSION_TTL_MS) {
      return null;
    }

    if (
      !parsed.currentRound.items.every(isReadingRoundItem) ||
      !parsed.invalidQuestions.every((item) => typeof item === "string") ||
      !parsed.candidatePool.every(isReadingCandidate) ||
      !parsed.reviewQueue.every(isReadingCandidate) ||
      !parsed.approvedAnchors.every(isApprovedAnchor) ||
      !parsed.submittedRounds.every(isSubmittedRound) ||
      (parsed.summary !== null && parsed.summary !== undefined && !isSummaryState(parsed.summary))
    ) {
      return null;
    }

    return parsed as ReadingSession;
  } catch {
    return null;
  }
}

export function serializeReadingSession(session: ReadingSession) {
  return JSON.stringify(session);
}

export function mapApprovedAnchors(items: ReadingRoundItem[]): ApprovedReadingAnchor[] {
  return items.map((item) => ({
    id: item.id,
    question: item.question,
    answer: item.answer,
    themeId: item.themeId,
    themeLabel: item.themeLabel,
  }));
}

export function cloneRoundItems(candidates: ReadingCandidate[]) {
  return candidates.map(makeRoundItem);
}
