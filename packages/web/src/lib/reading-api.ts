import {
  composeNextRound,
  getReadingLengthState,
  READING_ROUND_MAX_ITEMS,
  READING_THEME_MAX_ITEMS,
  type ApprovedReadingAnchor,
  type ReadingCandidate,
  type ReadingLocale,
} from "./reading-session";
import i18n from "./i18n";
import type { ApiClient } from "./api-client";

export interface StartReadingInput {
  locale?: ReadingLocale;
  text: string;
}

export interface GeneratedRound {
  items: ReadingCandidate[];
  candidatePool: ReadingCandidate[];
}

export interface SummarizeRoundInput {
  locale?: ReadingLocale;
  text: string;
  approvedAnchors: ApprovedReadingAnchor[];
  currentRoundItems: ReadingCandidate[];
  invalidQuestions?: string[];
}

export interface RoundSummaryResult {
  coveredTopics: string[];
  missingTopics: string[];
}

export interface GenerateNextRoundInput {
  locale?: ReadingLocale;
  text: string;
  approvedAnchors: ApprovedReadingAnchor[];
  reviewQueue: ReadingCandidate[];
  candidatePool: ReadingCandidate[];
  selectedMissingTopics: string[];
  extraFocus: string;
  invalidQuestions: string[];
}

export interface ReadingApi {
  generateFirstRound(input: StartReadingInput): Promise<GeneratedRound>;
  summarizeRound(input: SummarizeRoundInput): Promise<RoundSummaryResult>;
  generateNextRound(input: GenerateNextRoundInput): Promise<GeneratedRound>;
}

export function createReadingApi(apiClient: ApiClient): ReadingApi {
  return {
    async generateFirstRound(input) {
      const response = await apiClient.post<{ data: GeneratedRound }>(
        apiClient.ownerPath("/reading/start"),
        input,
      );
      return response.data;
    },
    async summarizeRound(input) {
      const response = await apiClient.post<{ data: RoundSummaryResult }>(
        apiClient.ownerPath("/reading/summarize"),
        input,
      );
      return response.data;
    },
    async generateNextRound(input) {
      const response = await apiClient.post<{ data: GeneratedRound }>(
        apiClient.ownerPath("/reading/next-round"),
        input,
      );
      return response.data;
    },
  };
}

export async function persistReadingApprovedAnchors(
  apiClient: ApiClient,
  anchors: ApprovedReadingAnchor[],
) {
  await Promise.all(
    anchors.map((anchor) =>
      apiClient.post(apiClient.ownerPath("/anchors"), {
        question: anchor.question,
        answer: anchor.answer,
        source: "manual",
      }),
    ),
  );
}

const THEME_KEYWORDS = {
  "value-judgments": ["重要", "价值", "原则", "值得", "意义", "better", "important", "value"],
  relationships: ["关系", "别人", "朋友", "合作", "信任", "relationship", "trust"],
  "conflict-handling": ["冲突", "分歧", "边界", "拒绝", "conflict", "boundary"],
  "work-style": ["工作", "做事", "效率", "执行", "实验", "work", "ship"],
  growth: ["成长", "学习", "改变", "长期", "future", "learn", "grow"],
} as const;

const READING_COPY = {
  zh: {
    themes: {
      "value-judgments": {
        label: "价值观判断",
        question: "这段文本里，我在价值判断上最看重什么？",
      },
      relationships: {
        label: "长期关系",
        question: "这段文本里，我希望如何处理长期关系？",
      },
      "conflict-handling": {
        label: "冲突处理",
        question: "这段文本里，我处理冲突和边界时遵循什么原则？",
      },
      "work-style": {
        label: "工作方式",
        question: "这段文本里，我偏好的工作方式是什么？",
      },
      growth: {
        label: "成长路径",
        question: "这段文本里，我如何看待成长与长期变化？",
      },
    },
    missingTopics: ["边界条件", "长期关系", "冲突处理", "工作取舍", "长期变化"],
    reviewFallback: {
      withHint: "基于原文重审后，这一题的答案需要更谨慎地重新表述。",
      withoutHint: "基于原文重审后，这一题的答案需要重新表述。",
    },
  },
  en: {
    themes: {
      "value-judgments": {
        label: "Value judgments",
        question: "In this text, what matters most in my value judgments?",
      },
      relationships: {
        label: "Long-term relationships",
        question: "In this text, how do I want to handle long-term relationships?",
      },
      "conflict-handling": {
        label: "Conflict handling",
        question: "In this text, what principles guide how I handle conflict and boundaries?",
      },
      "work-style": {
        label: "Work style",
        question: "In this text, what kind of work style do I prefer?",
      },
      growth: {
        label: "Growth path",
        question: "In this text, how do I view growth and long-term change?",
      },
    },
    missingTopics: [
      "Boundaries",
      "Long-term relationships",
      "Conflict handling",
      "Work trade-offs",
      "Long-term change",
    ],
    reviewFallback: {
      withHint: "After reviewing the source text again, this answer needs a more careful rewrite.",
      withoutHint: "After reviewing the source text again, this answer needs to be rewritten.",
    },
  },
} as const;

type ReadingThemeId = keyof typeof THEME_KEYWORDS;

function getReadingLocale() {
  return (i18n.resolvedLanguage ?? i18n.language)?.startsWith("en") ? "en" : "zh";
}

function getReadingCopy(locale?: ReadingLocale) {
  return READING_COPY[locale ?? getReadingLocale()];
}

function getThemeDefinitions(locale?: ReadingLocale) {
  const copy = getReadingCopy(locale);
  return (Object.keys(THEME_KEYWORDS) as ReadingThemeId[]).map((id) => ({
    id,
    label: copy.themes[id].label,
    question: copy.themes[id].question,
    keywords: THEME_KEYWORDS[id],
  }));
}

export function getDefaultMissingTopics(locale?: ReadingLocale) {
  return [...getReadingCopy(locale).missingTopics];
}

function normalizeTopicKey(topic: string) {
  return topic.trim().toLowerCase();
}

export function normalizeMissingTopics(
  missingTopics: string[],
  coveredTopics: string[],
  locale?: ReadingLocale,
) {
  const covered = new Set(coveredTopics.map(normalizeTopicKey).filter(Boolean));
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const topic of missingTopics) {
    const trimmed = topic.trim();
    const key = normalizeTopicKey(trimmed);
    if (!trimmed || covered.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(trimmed);
  }

  for (const fallback of getDefaultMissingTopics(locale)) {
    if (normalized.length >= 5) {
      break;
    }
    const key = normalizeTopicKey(fallback);
    if (covered.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(fallback);
  }

  return normalized.slice(0, Math.min(5, Math.max(3, normalized.length)));
}

function splitTextIntoUnits(text: string) {
  const paragraphs = text
    .split(/\n\s*\n/g)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (paragraphs.length > 1) {
    return paragraphs;
  }

  return text
    .split(/[。！？!?.]+\s*/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function scoreUnitForTheme(unit: string, keywords: readonly string[]) {
  const lower = unit.toLowerCase();
  return keywords.reduce(
    (score, keyword) => score + (lower.includes(keyword.toLowerCase()) ? 1 : 0),
    0,
  );
}

function createCandidate(
  themeId: string,
  themeLabel: string,
  question: string,
  unit: string,
  index: number,
  locale: ReadingLocale = "zh",
) {
  const snippet = unit.slice(0, 180);
  const focus = unit.replace(/\s+/g, " ").trim().slice(0, 28);
  return {
    id: `${themeId}-${index}`,
    question: locale === "en" ? `${question} Focus: ${focus}` : `${question}（聚焦：${focus}）`,
    answer: unit.slice(0, 140),
    themeId,
    themeLabel,
    score: Math.max(0.1, Math.min(1, unit.length / 240)),
    sourceSnippet: snippet,
    origin: "new",
  } satisfies ReadingCandidate;
}

function filterInvalidQuestions(candidates: ReadingCandidate[], invalidQuestions: string[]) {
  if (invalidQuestions.length === 0) {
    return candidates;
  }

  const blocked = new Set(invalidQuestions.map((question) => question.trim()));
  return candidates.filter((candidate) => !blocked.has(candidate.question.trim()));
}

export function buildDeterministicRoundFromText(
  text: string,
  locale?: ReadingLocale,
): GeneratedRound {
  if (getReadingLengthState(text).isTooLong) {
    throw new Error("READING_TEXT_TOO_LONG");
  }

  const themeDefinitions = getThemeDefinitions(locale);
  const units = splitTextIntoUnits(text);
  const generated: ReadingCandidate[] = [];

  units.forEach((unit, index) => {
    const match =
      themeDefinitions
        .map((theme) => ({
          theme,
          score: scoreUnitForTheme(unit, theme.keywords),
        }))
        .sort((a, b) => b.score - a.score)[0] ?? null;

    const theme =
      match && match.score > 0 ? match.theme : themeDefinitions[index % themeDefinitions.length];
    generated.push(createCandidate(theme.id, theme.label, theme.question, unit, index, locale));
  });

  const composed = composeNextRound({
    approvedAnchors: [],
    reviewQueue: [],
    candidatePool: generated,
    maxItems: READING_ROUND_MAX_ITEMS,
    maxPerTheme: READING_THEME_MAX_ITEMS,
  });

  return {
    items: composed.items,
    candidatePool: composed.deferredCandidatePool,
  };
}

export function buildDeterministicSummary(input: SummarizeRoundInput): RoundSummaryResult {
  const themeDefinitions = getThemeDefinitions(input.locale);
  const coveredTopics = Array.from(
    new Set(input.approvedAnchors.map((item) => item.themeLabel).filter(Boolean)),
  );
  const invalidQuestions = new Set(
    (input.invalidQuestions ?? []).map((question) => question.trim()),
  );
  const lowerText = input.text.toLowerCase();
  const rankedTopics = themeDefinitions
    .filter(
      (theme) => !coveredTopics.includes(theme.label) && !invalidQuestions.has(theme.question),
    )
    .map((theme) => ({
      label: theme.label,
      score: theme.keywords.reduce(
        (score, keyword) => score + (lowerText.includes(keyword.toLowerCase()) ? 1 : 0),
        0,
      ),
    }))
    .sort((a, b) => b.score - a.score)
    .map((theme) => theme.label);

  return {
    coveredTopics,
    missingTopics: normalizeMissingTopics(rankedTopics, coveredTopics, input.locale),
  };
}

function rewriteReviewAnswers(reviewQueue: ReadingCandidate[], locale?: ReadingLocale) {
  const copy = getReadingCopy(locale);
  const synthesizeReviewAnswer = (item: ReadingCandidate) => {
    const sourceBasedAnswer = item.sourceSnippet?.trim();
    if (sourceBasedAnswer) {
      return sourceBasedAnswer.slice(0, 140);
    }

    if (item.reviewHint?.trim()) {
      return `${copy.reviewFallback.withHint} ${item.reviewHint.trim()}`;
    }

    return copy.reviewFallback.withoutHint;
  };

  return reviewQueue.map((item) => ({
    ...item,
    answer: synthesizeReviewAnswer(item),
    origin: "review" as const,
  }));
}

export function buildDeterministicNextRound(input: GenerateNextRoundInput): GeneratedRound {
  const extraRound = buildDeterministicRoundFromText(
    `${input.text}\n${input.selectedMissingTopics.join(" ")}\n${input.extraFocus}`,
    input.locale,
  );
  const extraCandidates = [...extraRound.items, ...extraRound.candidatePool].map((item, index) => ({
    ...item,
    id: `${item.id}-next-${index}`,
  }));

  const composed = composeNextRound({
    approvedAnchors: input.approvedAnchors,
    reviewQueue: rewriteReviewAnswers(input.reviewQueue, input.locale),
    candidatePool: filterInvalidQuestions(
      [...input.candidatePool, ...extraCandidates],
      input.invalidQuestions,
    ),
    maxItems: READING_ROUND_MAX_ITEMS,
    maxPerTheme: READING_THEME_MAX_ITEMS,
  });

  return {
    items: composed.items,
    candidatePool: [...composed.deferredReviewQueue, ...composed.deferredCandidatePool],
  };
}

export const readingApi: ReadingApi = {
  async generateFirstRound(input) {
    return buildDeterministicRoundFromText(input.text, input.locale);
  },
  async summarizeRound(input) {
    return buildDeterministicSummary(input);
  },
  async generateNextRound(input) {
    return buildDeterministicNextRound(input);
  },
};
