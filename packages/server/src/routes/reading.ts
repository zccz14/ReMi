import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { extractAllTags, parseAllTagObjects } from "../llm/xml-parser.js";
import type { ChatClient, ChatMessage } from "../llm/client.js";

type ReadingLocale = "zh" | "en";

type ReadingCandidate = {
  id: string;
  question: string;
  answer: string;
  themeId: string;
  themeLabel: string;
  score: number;
  sourceSnippet?: string;
  origin?: "new" | "review";
  reviewHint?: string;
};

type ApprovedReadingAnchor = {
  id: string;
  question: string;
  answer: string;
  themeId: string;
  themeLabel: string;
};

const READING_MAX_LENGTH = 50_000;
const READING_ROUND_MAX_ITEMS = 18;
const READING_THEME_MAX_ITEMS = 6;

const THEME_LABELS = {
  zh: {
    "value-judgments": "价值观判断",
    relationships: "长期关系",
    "conflict-handling": "冲突处理",
    "work-style": "工作方式",
    growth: "成长路径",
  },
  en: {
    "value-judgments": "Value judgments",
    relationships: "Long-term relationships",
    "conflict-handling": "Conflict handling",
    "work-style": "Work style",
    growth: "Growth path",
  },
} as const;

const DEFAULT_MISSING_TOPICS = {
  zh: ["边界条件", "长期关系", "冲突处理", "工作取舍", "长期变化"],
  en: [
    "Boundaries",
    "Long-term relationships",
    "Conflict handling",
    "Work trade-offs",
    "Long-term change",
  ],
} as const;

const approvedAnchorSchema = z.object({
  id: z.string(),
  question: z.string(),
  answer: z.string(),
  themeId: z.string(),
  themeLabel: z.string(),
});

const candidateSchema = z.object({
  id: z.string(),
  question: z.string(),
  answer: z.string(),
  themeId: z.string(),
  themeLabel: z.string(),
  score: z.number(),
  sourceSnippet: z.string().optional(),
  origin: z.enum(["new", "review"]).optional(),
  reviewHint: z.string().optional(),
});

const startSchema = z.object({
  locale: z.enum(["zh", "en"]).optional(),
  text: z.string().min(1).max(READING_MAX_LENGTH),
});

const summarizeSchema = z.object({
  locale: z.enum(["zh", "en"]).optional(),
  text: z.string().min(1).max(READING_MAX_LENGTH),
  approvedAnchors: z.array(approvedAnchorSchema),
  currentRoundItems: z.array(candidateSchema),
  invalidQuestions: z.array(z.string()).optional(),
});

const nextRoundSchema = z.object({
  locale: z.enum(["zh", "en"]).optional(),
  text: z.string().min(1).max(READING_MAX_LENGTH),
  approvedAnchors: z.array(approvedAnchorSchema),
  reviewQueue: z.array(candidateSchema),
  candidatePool: z.array(candidateSchema),
  selectedMissingTopics: z.array(z.string()),
  extraFocus: z.string(),
  invalidQuestions: z.array(z.string()),
});

function requireOwner(c: Context): Response | null {
  if (c.get("role") !== "owner") {
    return c.json({ error: "FORBIDDEN", message: "Owner access required" }, 403);
  }
  return null;
}

function getThemeLabel(themeId: string, locale: ReadingLocale, fallback?: string) {
  return (
    THEME_LABELS[locale][themeId as keyof (typeof THEME_LABELS)[ReadingLocale]] ??
    fallback ??
    themeId
  );
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

function dedupeCandidates(
  candidates: ReadingCandidate[],
  approvedAnchors: ApprovedReadingAnchor[],
  seenKeys: Set<string> = new Set<string>(),
) {
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

function composeRound(input: {
  approvedAnchors: ApprovedReadingAnchor[];
  reviewQueue: ReadingCandidate[];
  candidatePool: ReadingCandidate[];
}) {
  const themeCounts = new Map<string, number>();
  const seenKeys = new Set<string>();
  const review = dedupeCandidates(
    input.reviewQueue.map((item) => ({ ...item, origin: "review" as const })),
    input.approvedAnchors,
    seenKeys,
  );
  const candidates = dedupeCandidates(
    [...input.candidatePool]
      .sort((a, b) => b.score - a.score)
      .map((item) => ({ ...item, origin: item.origin ?? "new" })),
    input.approvedAnchors,
    seenKeys,
  );

  const items: ReadingCandidate[] = [];
  const deferredReviewQueue: ReadingCandidate[] = [];
  const deferredCandidatePool: ReadingCandidate[] = [];

  const pushIfAllowed = (candidate: ReadingCandidate, deferredTarget: ReadingCandidate[]) => {
    const count = themeCounts.get(candidate.themeId) ?? 0;
    if (items.length >= READING_ROUND_MAX_ITEMS || count >= READING_THEME_MAX_ITEMS) {
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
    candidatePool: [...deferredReviewQueue, ...deferredCandidatePool],
  };
}

function normalizeMissingTopics(
  missingTopics: string[],
  coveredTopics: string[],
  locale: ReadingLocale,
) {
  const covered = new Set(coveredTopics.map((item) => normalizeText(item)).filter(Boolean));
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const topic of missingTopics) {
    const trimmed = topic.trim();
    const key = normalizeText(trimmed);
    if (!trimmed || covered.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(trimmed);
  }

  for (const fallback of DEFAULT_MISSING_TOPICS[locale]) {
    if (normalized.length >= 5) break;
    const key = normalizeText(fallback);
    if (covered.has(key) || seen.has(key)) continue;
    seen.add(key);
    normalized.push(fallback);
  }

  return normalized.slice(0, Math.min(5, Math.max(3, normalized.length)));
}

function parseScore(value: string | undefined) {
  const parsed = Number(value ?? "0.7");
  if (!Number.isFinite(parsed)) {
    return 0.7;
  }
  return Math.max(0.1, Math.min(1, parsed));
}

function parseCandidateTags(
  text: string,
  parentTag: string,
  locale: ReadingLocale,
  origin?: "new" | "review",
) {
  return parseAllTagObjects(text, parentTag, [
    "id",
    "question",
    "answer",
    "theme_id",
    "theme_label",
    "score",
    "source_snippet",
  ])
    .map((item, index) => {
      const question = item.question?.trim();
      const answer = item.answer?.trim();
      const themeId = item.theme_id?.trim() || "value-judgments";
      if (!question || !answer) {
        return null;
      }

      const candidate: ReadingCandidate = {
        id: item.id?.trim() || `${parentTag}-${index + 1}`,
        question,
        answer,
        themeId,
        themeLabel: getThemeLabel(themeId, locale, item.theme_label?.trim()),
        score: parseScore(item.score),
        sourceSnippet: item.source_snippet?.trim() || undefined,
        origin,
      };

      return candidate;
    })
    .filter((item): item is ReadingCandidate => Boolean(item));
}

async function runChat(chatClient: ChatClient, messages: ChatMessage[]) {
  const response = await chatClient.chat({ messages, temperature: 0 });
  return response.content;
}

function buildStartMessages(locale: ReadingLocale, text: string): ChatMessage[] {
  const system =
    locale === "en"
      ? [
          "You extract candidate soul anchors from one full long text.",
          "Read the entire text, not a summary.",
          "Return only XML using repeated <candidate> blocks.",
          "Each <candidate> must include <question>, <answer>, <theme_id>, <theme_label>, <score>, <source_snippet>.",
          "Use theme_id from: value-judgments, relationships, conflict-handling, work-style, growth.",
          "Questions should be first-person and reviewable by the owner.",
          "Avoid duplicates and keep source_snippet copied from the original text.",
        ].join(" ")
      : [
          "你要从一段完整长文本中提取候选灵魂锚点。",
          "必须基于全文阅读，不要只看摘要。",
          "只返回 XML，使用重复的 <candidate> 块。",
          "每个 <candidate> 都必须包含 <question>、<answer>、<theme_id>、<theme_label>、<score>、<source_snippet>。",
          "theme_id 只能使用 value-judgments、relationships、conflict-handling、work-style、growth。",
          "问题要用第一人称，适合作为阅读理解问卷题。",
          "避免重复，source_snippet 尽量直接引用原文片段。",
        ].join("");

  return [
    { role: "system", content: system },
    { role: "user", content: text },
  ];
}

function buildSummaryMessages(input: {
  locale: ReadingLocale;
  text: string;
  approvedAnchors: ApprovedReadingAnchor[];
  invalidQuestions: string[];
}) {
  const approved = input.approvedAnchors
    .map((anchor) => `Q: ${anchor.question}\nA: ${anchor.answer}\nTheme: ${anchor.themeLabel}`)
    .join("\n\n");
  const invalidQuestions = input.invalidQuestions.join("\n");
  const system =
    input.locale === "en"
      ? [
          "You summarize covered topics and suggest 3-5 missing topics for another reading round.",
          "Return only XML with repeated <covered>topic</covered> and <missing>topic</missing> tags.",
          "Exclude already covered topics from missing topics.",
          "Base the result only on the full text and submitted feedback.",
        ].join(" ")
      : [
          "你要总结已覆盖主题，并给出 3-5 个下一轮可能遗漏的话题建议。",
          "只返回 XML，使用重复的 <covered>主题</covered> 和 <missing>主题</missing> 标签。",
          "遗漏话题必须排除已经覆盖的主题。",
          "只能基于全文和已提交反馈判断。",
        ].join("");

  return [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        `TEXT:\n${input.text}`,
        `\n\nAPPROVED ANCHORS:\n${approved || "(none)"}`,
        `\n\nINVALID QUESTIONS:\n${invalidQuestions || "(none)"}`,
      ].join(""),
    },
  ] satisfies ChatMessage[];
}

function buildReviewRewriteMessages(input: {
  locale: ReadingLocale;
  text: string;
  reviewQueue: ReadingCandidate[];
}) {
  const reviewItems = input.reviewQueue
    .map((item) => {
      const hint = item.reviewHint?.trim() ? `\nHint: ${item.reviewHint.trim()}` : "";
      return [
        "<item>",
        `<id>${item.id}</id>`,
        `<question>${item.question}</question>`,
        `<theme_id>${item.themeId}</theme_id>`,
        `<theme_label>${item.themeLabel}</theme_label>`,
        hint,
        "</item>",
      ].join("\n");
    })
    .join("\n");

  const system =
    input.locale === "en"
      ? [
          "You rewrite answers for review items while keeping the exact same question.",
          "Return only XML using repeated <review> blocks.",
          "Each <review> must include <id>, <question>, <answer>, <theme_id>, <theme_label>, <score>, <source_snippet>.",
        ].join(" ")
      : [
          "你要为待重审题重写答案，但必须保持问题完全不变。",
          "只返回 XML，使用重复的 <review> 块。",
          "每个 <review> 都必须包含 <id>、<question>、<answer>、<theme_id>、<theme_label>、<score>、<source_snippet>。",
        ].join("");

  return [
    { role: "system", content: system },
    { role: "user", content: `TEXT:\n${input.text}\n\nREVIEW ITEMS:\n${reviewItems}` },
  ] satisfies ChatMessage[];
}

function buildNextRoundMessages(input: {
  locale: ReadingLocale;
  text: string;
  approvedAnchors: ApprovedReadingAnchor[];
  invalidQuestions: string[];
  selectedMissingTopics: string[];
  extraFocus: string;
}) {
  const approved = input.approvedAnchors
    .map((anchor) => `Q: ${anchor.question}\nA: ${anchor.answer}\nTheme: ${anchor.themeLabel}`)
    .join("\n\n");
  const focus = [...input.selectedMissingTopics, input.extraFocus.trim()]
    .filter(Boolean)
    .join("\n");
  const invalidQuestions = input.invalidQuestions.join("\n");
  const system =
    input.locale === "en"
      ? [
          "You generate additional candidate soul anchors for the next reading round.",
          "Use the full text, missing-topic focus, approved anchors, and invalid-question feedback.",
          "Return only XML using repeated <candidate> blocks with <question>, <answer>, <theme_id>, <theme_label>, <score>, <source_snippet>.",
          "Avoid already approved coverage and avoid repeating invalid question patterns.",
        ].join(" ")
      : [
          "你要为下一轮生成新的候选灵魂锚点。",
          "必须同时参考全文、遗漏主题、已认可锚点和问题不对反馈。",
          "只返回 XML，使用重复的 <candidate> 块，并包含 <question>、<answer>、<theme_id>、<theme_label>、<score>、<source_snippet>。",
          "避免重复已覆盖内容，也避免重复无效问题模式。",
        ].join("");

  return [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        `TEXT:\n${input.text}`,
        `\n\nAPPROVED ANCHORS:\n${approved || "(none)"}`,
        `\n\nINVALID QUESTIONS:\n${invalidQuestions || "(none)"}`,
        `\n\nNEXT ROUND FOCUS:\n${focus || "(none)"}`,
      ].join(""),
    },
  ] satisfies ChatMessage[];
}

async function generateFirstRound(chatClient: ChatClient, locale: ReadingLocale, text: string) {
  const content = await runChat(chatClient, buildStartMessages(locale, text));
  const candidates = parseCandidateTags(content, "candidate", locale, "new");
  return composeRound({ approvedAnchors: [], reviewQueue: [], candidatePool: candidates });
}

async function summarizeRound(
  chatClient: ChatClient,
  input: {
    locale: ReadingLocale;
    text: string;
    approvedAnchors: ApprovedReadingAnchor[];
    invalidQuestions: string[];
  },
) {
  const content = await runChat(chatClient, buildSummaryMessages(input));
  const coveredTopics = Array.from(
    new Set(
      extractAllTags(content, "covered")
        .map((item) => item.trim())
        .filter(Boolean)
        .concat(input.approvedAnchors.map((anchor) => anchor.themeLabel).filter(Boolean)),
    ),
  );
  const missingTopics = normalizeMissingTopics(
    extractAllTags(content, "missing").map((item) => item.trim()),
    coveredTopics,
    input.locale,
  );

  return { coveredTopics, missingTopics };
}

async function generateNextRound(
  chatClient: ChatClient,
  input: {
    locale: ReadingLocale;
    text: string;
    approvedAnchors: ApprovedReadingAnchor[];
    reviewQueue: ReadingCandidate[];
    candidatePool: ReadingCandidate[];
    selectedMissingTopics: string[];
    extraFocus: string;
    invalidQuestions: string[];
  },
) {
  const rewrittenReview =
    input.reviewQueue.length > 0
      ? parseCandidateTags(
          await runChat(
            chatClient,
            buildReviewRewriteMessages({
              locale: input.locale,
              text: input.text,
              reviewQueue: input.reviewQueue,
            }),
          ),
          "review",
          input.locale,
          "review",
        )
      : [];
  const nextCandidates = parseCandidateTags(
    await runChat(
      chatClient,
      buildNextRoundMessages({
        locale: input.locale,
        text: input.text,
        approvedAnchors: input.approvedAnchors,
        invalidQuestions: input.invalidQuestions,
        selectedMissingTopics: input.selectedMissingTopics,
        extraFocus: input.extraFocus,
      }),
    ),
    "candidate",
    input.locale,
    "new",
  );

  return composeRound({
    approvedAnchors: input.approvedAnchors,
    reviewQueue: rewrittenReview,
    candidatePool: [...input.candidatePool, ...nextCandidates],
  });
}

export const readingRoutes = new Hono();

readingRoutes.post(
  "/:pubKey/reading/start",
  zValidator("json", startSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "VALIDATION_ERROR", message: result.error.message }, 422);
    }
  }),
  async (c) => {
    const forbidden = requireOwner(c);
    if (forbidden) return forbidden;

    const chatClient = c.get("chatClient") as ChatClient | null;
    if (!chatClient) {
      return c.json({ error: "LLM_ERROR", message: "Chat client not configured" }, 500);
    }

    const body = c.req.valid("json");
    const locale = body.locale ?? "zh";
    const result = await generateFirstRound(chatClient, locale, body.text);
    return c.json({ data: result });
  },
);

readingRoutes.post(
  "/:pubKey/reading/summarize",
  zValidator("json", summarizeSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "VALIDATION_ERROR", message: result.error.message }, 422);
    }
  }),
  async (c) => {
    const forbidden = requireOwner(c);
    if (forbidden) return forbidden;

    const chatClient = c.get("chatClient") as ChatClient | null;
    if (!chatClient) {
      return c.json({ error: "LLM_ERROR", message: "Chat client not configured" }, 500);
    }

    const body = c.req.valid("json");
    const locale = body.locale ?? "zh";
    const result = await summarizeRound(chatClient, {
      locale,
      text: body.text,
      approvedAnchors: body.approvedAnchors,
      invalidQuestions: body.invalidQuestions ?? [],
    });
    return c.json({ data: result });
  },
);

readingRoutes.post(
  "/:pubKey/reading/next-round",
  zValidator("json", nextRoundSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "VALIDATION_ERROR", message: result.error.message }, 422);
    }
  }),
  async (c) => {
    const forbidden = requireOwner(c);
    if (forbidden) return forbidden;

    const chatClient = c.get("chatClient") as ChatClient | null;
    if (!chatClient) {
      return c.json({ error: "LLM_ERROR", message: "Chat client not configured" }, 500);
    }

    const body = c.req.valid("json");
    const locale = body.locale ?? "zh";
    const result = await generateNextRound(chatClient, {
      locale,
      text: body.text,
      approvedAnchors: body.approvedAnchors,
      reviewQueue: body.reviewQueue,
      candidatePool: body.candidatePool,
      selectedMissingTopics: body.selectedMissingTopics,
      extraFocus: body.extraFocus,
      invalidQuestions: body.invalidQuestions,
    });
    return c.json({ data: result });
  },
);
