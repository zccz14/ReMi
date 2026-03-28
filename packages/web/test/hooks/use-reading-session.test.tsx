import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "../helpers/test-utils";
import { useReadingSession } from "../../src/hooks/use-reading-session";
import {
  READING_SESSION_STORAGE_KEY,
  type ReadingCandidate,
  type ReadingSession,
} from "../../src/lib/reading-session";
import type { ReadingApi } from "../../src/lib/reading-api";
import i18n from "../../src/lib/i18n";

const seededLongText = "我很看重长期关系里的信任，也会在有冲突时明确边界。".repeat(40);

function makeCandidate(
  id: string,
  themeId: string,
  themeLabel: string,
  answer = `answer-${id}`,
): ReadingCandidate {
  return {
    id,
    question: `question-${id}`,
    answer,
    themeId,
    themeLabel,
    score: 0.9,
    sourceSnippet: `source snippet ${id}`,
    origin: "new",
  };
}

function seedGenerationResult() {
  return {
    items: [
      makeCandidate("item-1", "theme-a", "价值观判断"),
      makeCandidate("item-2", "theme-b", "长期关系"),
      makeCandidate("item-3", "theme-c", "冲突处理"),
    ],
    candidatePool: [makeCandidate("item-4", "theme-d", "工作方式")],
  };
}

function seededReadingApi(): ReadingApi {
  return {
    generateFirstRound: vi.fn().mockResolvedValue(seedGenerationResult()),
    summarizeRound: vi.fn().mockResolvedValue({
      coveredTopics: ["价值观判断", "长期关系"],
      missingTopics: ["边界条件", "长期关系", "冲突处理"],
    }),
    generateNextRound: vi.fn().mockResolvedValue({
      items: [
        { ...makeCandidate("review-1", "theme-a", "价值观判断"), origin: "review" },
        makeCandidate("next-1", "theme-e", "成长路径"),
      ],
      candidatePool: [makeCandidate("next-2", "theme-f", "工作方式")],
    }),
  };
}

function seedSessionWithQueues(): ReadingSession {
  return {
    locale: "zh",
    status: "active",
    stage: "questionnaire",
    text: seededLongText,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    currentRound: {
      index: 1,
      items: [
        {
          ...makeCandidate("item-1", "theme-a", "价值观判断"),
          selection: "answer_invalid",
          correctionHint: "focus on the exception",
          isSourceOpen: false,
        },
      ],
    },
    candidatePool: [
      makeCandidate("pool-1", "theme-b", "长期关系"),
      makeCandidate("pool-2", "theme-b", "长期关系"),
      makeCandidate("pool-3", "theme-c", "冲突处理"),
      makeCandidate("pool-4", "theme-d", "工作方式"),
    ],
    reviewQueue: [
      { ...makeCandidate("review-1", "theme-a", "价值观判断"), origin: "review" },
      { ...makeCandidate("review-2", "theme-a", "价值观判断"), origin: "review" },
    ],
    invalidQuestions: ["question-item-2"],
    approvedAnchors: [
      {
        id: "approved-1",
        question: "approved-question",
        answer: "approved-answer",
        themeId: "theme-approved",
        themeLabel: "价值观判断",
      },
    ],
    submittedRounds: [],
    summary: null,
  };
}

function seedSummaryStageSession(): ReadingSession {
  return {
    ...seedSessionWithQueues(),
    stage: "summary",
    summary: {
      coveredTopics: ["价值观判断", "长期关系"],
      missingTopics: ["边界条件", "长期关系", "冲突处理"],
      selectedMissingTopics: ["边界条件"],
      extraFocus: "如何处理长期冲突",
      invalidQuestions: ["不该这样提问吗？"],
    },
  };
}

function seedClosedSession(): ReadingSession {
  return {
    ...seedSummaryStageSession(),
    status: "closed",
    stage: "closed",
  };
}

function seedExpiredSession(): ReadingSession {
  return {
    ...seedSessionWithQueues(),
    createdAt: 1,
    updatedAt: 1,
  };
}

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("useReadingSession", () => {
  it("starts a session from adapter-provided first-round data", async () => {
    const readingApi = seededReadingApi();
    const { result } = renderHook(() => useReadingSession({ readingApi }));

    await act(async () => {
      await result.current.startSession({ text: seededLongText });
    });

    expect(readingApi.generateFirstRound).toHaveBeenCalledWith(
      expect.objectContaining({ text: seededLongText, locale: expect.any(String) }),
    );
    expect(result.current.session?.currentRound.items).toHaveLength(3);
  });

  it("restores an unfinished session including queues and correction hints", () => {
    window.localStorage.setItem(
      READING_SESSION_STORAGE_KEY,
      JSON.stringify(seedSessionWithQueues()),
    );
    const { result } = renderHook(() => useReadingSession({ readingApi: seededReadingApi() }));

    expect(result.current.session?.currentRound.items[0].correctionHint).toBe(
      "focus on the exception",
    );
    expect(result.current.session?.approvedAnchors).toHaveLength(1);
    expect(result.current.session?.reviewQueue).toHaveLength(2);
    expect(result.current.session?.candidatePool).toHaveLength(4);
  });

  it("restores summary selections and free-text focus", () => {
    window.localStorage.setItem(
      READING_SESSION_STORAGE_KEY,
      JSON.stringify(seedSummaryStageSession()),
    );
    const { result } = renderHook(() => useReadingSession({ readingApi: seededReadingApi() }));

    expect(result.current.session?.summary?.selectedMissingTopics).toEqual(["边界条件"]);
    expect(result.current.session?.summary?.extraFocus).toBe("如何处理长期冲突");
  });

  it("drops expired sessions older than 24 hours", () => {
    window.localStorage.setItem(READING_SESSION_STORAGE_KEY, JSON.stringify(seedExpiredSession()));
    const { result } = renderHook(() =>
      useReadingSession({ readingApi: seededReadingApi(), now: () => 24 * 60 * 60 * 1000 + 2 }),
    );

    expect(result.current.session).toBeNull();
    expect(window.localStorage.getItem(READING_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("does not persist or enqueue anything before submit", async () => {
    const persistApproved = vi.fn();
    const readingApi = seededReadingApi();
    const { result } = renderHook(() => useReadingSession({ readingApi, persistApproved }));

    await act(async () => {
      await result.current.startSession({ text: seededLongText });
    });

    act(() => result.current.selectItem("item-1", "approved"));
    act(() => result.current.selectItem("item-2", "question_invalid"));
    act(() => result.current.selectItem("item-3", "answer_invalid"));
    act(() => result.current.setCorrectionHint("item-3", "lean toward commitment over preference"));

    expect(persistApproved).not.toHaveBeenCalled();
    expect(readingApi.summarizeRound).not.toHaveBeenCalled();
    expect(result.current.session?.reviewQueue).toHaveLength(0);
  });

  it("keeps submission atomic when summary generation fails", async () => {
    const persistApproved = vi.fn();
    const readingApi = seededReadingApi();
    readingApi.summarizeRound = vi.fn().mockRejectedValue(new Error("summary exploded"));
    const { result } = renderHook(() => useReadingSession({ readingApi, persistApproved }));

    await act(async () => {
      await result.current.startSession({ text: seededLongText });
    });

    act(() => result.current.selectItem("item-1", "approved"));
    act(() => result.current.selectItem("item-2", "approved"));
    act(() => result.current.selectItem("item-3", "approved"));

    await expect(
      act(async () => {
        await result.current.submitRound();
      }),
    ).rejects.toThrow("summary exploded");

    expect(persistApproved).not.toHaveBeenCalled();
    expect(result.current.session?.stage).toBe("questionnaire");
    expect(result.current.session?.approvedAnchors).toHaveLength(0);
  });

  it("does not persist approved anchors when session storage fails during submit", async () => {
    const persistApproved = vi.fn();
    const storage = {
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
      setItem: vi.fn((_: string, value: string) => {
        if (value.includes('"stage":"summary"')) {
          throw new Error("storage exploded");
        }
      }),
    };
    const { result } = renderHook(() =>
      useReadingSession({ readingApi: seededReadingApi(), persistApproved, storage }),
    );

    await act(async () => {
      await result.current.startSession({ text: seededLongText });
    });

    act(() => result.current.selectItem("item-1", "approved"));
    act(() => result.current.selectItem("item-2", "approved"));
    act(() => result.current.selectItem("item-3", "approved"));

    await expect(
      act(async () => {
        await result.current.submitRound();
      }),
    ).rejects.toThrow("storage exploded");

    expect(persistApproved).not.toHaveBeenCalled();
    expect(result.current.session?.stage).toBe("questionnaire");
  });

  it("normalizes summary suggestions to 3-5 deduped uncovered topics", async () => {
    const readingApi = seededReadingApi();
    readingApi.summarizeRound = vi.fn().mockResolvedValue({
      coveredTopics: ["价值观判断", "长期关系"],
      missingTopics: ["长期关系", "边界条件", "边界条件"],
    });
    const { result } = renderHook(() => useReadingSession({ readingApi }));

    await act(async () => {
      await result.current.startSession({ text: seededLongText });
    });

    act(() => result.current.selectItem("item-1", "approved"));
    act(() => result.current.selectItem("item-2", "approved"));
    act(() => result.current.selectItem("item-3", "approved"));

    await act(async () => {
      await result.current.submitRound();
    });

    const missingTopics = result.current.session?.summary?.missingTopics ?? [];
    expect(missingTopics.length).toBeGreaterThanOrEqual(3);
    expect(missingTopics.length).toBeLessThanOrEqual(5);
    expect(missingTopics[0]).toBe("边界条件");
    expect(new Set(missingTopics).size).toBe(missingTopics.length);
    expect(missingTopics).not.toContain("长期关系");
  });

  it("does not suggest stopping after the first round when more review work remains", async () => {
    const readingApi = seededReadingApi();
    const { result } = renderHook(() => useReadingSession({ readingApi }));

    await act(async () => {
      await result.current.startSession({ text: seededLongText });
    });

    act(() => result.current.selectItem("item-1", "approved"));
    act(() => result.current.selectItem("item-2", "question_invalid"));
    act(() => result.current.selectItem("item-3", "answer_invalid"));

    await act(async () => {
      await result.current.submitRound();
    });

    expect(result.current.session?.summary?.shouldSuggestStop).toBe(false);
  });

  it("carries invalid-question feedback forward across later rounds", async () => {
    const readingApi = seededReadingApi();
    const { result } = renderHook(() => useReadingSession({ readingApi }));

    act(() => result.current.hydrate(seedSessionWithQueues()));
    act(() => result.current.selectItem("item-1", "approved"));
    act(() => result.current.selectItem("item-2", "question_invalid"));

    await act(async () => {
      await result.current.submitRound();
    });

    expect(result.current.session?.invalidQuestions).toEqual(["question-item-2"]);

    await act(async () => {
      await result.current.continueToNextRound();
    });

    expect(readingApi.generateNextRound).toHaveBeenCalledWith(
      expect.objectContaining({ invalidQuestions: ["question-item-2"] }),
    );
  });

  it("passes selected missing topics and free text into next-round generation", async () => {
    const readingApi = seededReadingApi();
    const { result } = renderHook(() => useReadingSession({ readingApi }));
    act(() => result.current.hydrate(seedSummaryStageSession()));

    act(() => result.current.toggleMissingTopic("边界条件"));
    act(() => result.current.toggleMissingTopic("冲突处理"));
    act(() => result.current.setExtraFocus("如何处理长期冲突"));

    await act(async () => {
      await result.current.continueToNextRound();
    });

    expect(readingApi.generateNextRound).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedMissingTopics: ["冲突处理"],
        extraFocus: "如何处理长期冲突",
        locale: "zh",
      }),
    );
  });

  it("reuses the session locale for later rounds even if app language changes", async () => {
    vi.spyOn(i18n, "resolvedLanguage", "get").mockReturnValue("en");
    vi.spyOn(i18n, "language", "get").mockReturnValue("en");
    const readingApi = seededReadingApi();
    const { result } = renderHook(() => useReadingSession({ readingApi }));

    act(() => result.current.hydrate(seedSummaryStageSession()));

    await act(async () => {
      await result.current.continueToNextRound();
    });

    expect(readingApi.generateNextRound).toHaveBeenCalledWith(
      expect.objectContaining({ locale: "zh" }),
    );
  });

  it("re-emits answer-invalid items as same-question review items with a revised answer", async () => {
    const { buildDeterministicNextRound } = await import("../../src/lib/reading-api");
    const result = buildDeterministicNextRound({
      locale: "zh",
      text: seededLongText,
      approvedAnchors: [],
      reviewQueue: [
        {
          ...makeCandidate("review-1", "theme-a", "价值观判断", "原答案"),
          question: "同一问题",
          reviewHint: "应该强调例外情况",
          origin: "review",
          sourceSnippet: undefined,
        },
      ],
      candidatePool: [],
      selectedMissingTopics: [],
      extraFocus: "",
      invalidQuestions: [],
    });

    expect(result.items[0].question).toBe("同一问题");
    expect(result.items[0].answer).not.toBe("原答案");
    expect(result.items[0].answer).toContain("应该强调例外情况");
  });

  it("still emits a revised answer when no snippet or correction hint is available", async () => {
    const { buildDeterministicNextRound } = await import("../../src/lib/reading-api");
    const result = buildDeterministicNextRound({
      locale: "zh",
      text: seededLongText,
      approvedAnchors: [],
      reviewQueue: [
        {
          ...makeCandidate("review-2", "theme-a", "价值观判断", "旧答案"),
          question: "同一问题",
          origin: "review",
          sourceSnippet: undefined,
          reviewHint: undefined,
        },
      ],
      candidatePool: [],
      selectedMissingTopics: [],
      extraFocus: "",
      invalidQuestions: [],
    });

    expect(result.items[0].question).toBe("同一问题");
    expect(result.items[0].answer).not.toBe("旧答案");
  });

  it("localizes deterministic adapter output for english", async () => {
    vi.spyOn(i18n, "resolvedLanguage", "get").mockReturnValue("en");
    vi.spyOn(i18n, "language", "get").mockReturnValue("en");
    const { buildDeterministicRoundFromText, buildDeterministicSummary } =
      await import("../../src/lib/reading-api");

    const round = buildDeterministicRoundFromText(
      "Long-term trust matters to me, and I want to handle conflict with clear boundaries.",
    );
    const summary = buildDeterministicSummary({
      locale: "en",
      text: seededLongText,
      approvedAnchors: [],
      currentRoundItems: round.items,
      invalidQuestions: [],
    });

    expect(round.items[0]?.question).toMatch(/[A-Za-z]/);
    expect(round.items[0]?.themeLabel).toMatch(/[A-Za-z]/);
    expect(summary.missingTopics.every((topic) => /[A-Za-z]/.test(topic))).toBe(true);
  });

  it("splits english prose into multiple candidate items", async () => {
    vi.spyOn(i18n, "resolvedLanguage", "get").mockReturnValue("en");
    vi.spyOn(i18n, "language", "get").mockReturnValue("en");
    const { buildDeterministicRoundFromText } = await import("../../src/lib/reading-api");

    const round = buildDeterministicRoundFromText(
      "Trust matters in long-term relationships. Conflict needs clear boundaries. Work should stay thoughtful.",
      "en",
    );

    expect(round.items.length).toBeGreaterThan(1);
  });

  it("uses text and prior feedback signals when building deterministic summary topics", async () => {
    vi.spyOn(i18n, "resolvedLanguage", "get").mockReturnValue("en");
    vi.spyOn(i18n, "language", "get").mockReturnValue("en");
    const { buildDeterministicSummary } = await import("../../src/lib/reading-api");

    const summary = buildDeterministicSummary({
      locale: "en",
      text: "I care about work quality, growth over time, and handling conflict with clear boundaries.",
      approvedAnchors: [
        {
          id: "approved-1",
          question: "q",
          answer: "a",
          themeId: "relationships",
          themeLabel: "Long-term relationships",
        },
      ],
      currentRoundItems: [],
      invalidQuestions: ["In this text, how do I want to handle long-term relationships?"],
    });

    expect(summary.missingTopics.some((topic) => /Work/i.test(topic))).toBe(true);
    expect(summary.missingTopics).toContain("Conflict handling");
    expect(summary.missingTopics).not.toContain("Long-term relationships");
  });

  it("generates distinct questions for different candidates in the same theme", async () => {
    vi.spyOn(i18n, "resolvedLanguage", "get").mockReturnValue("en");
    vi.spyOn(i18n, "language", "get").mockReturnValue("en");
    const { buildDeterministicRoundFromText } = await import("../../src/lib/reading-api");

    const round = buildDeterministicRoundFromText(
      "Trust matters in long-term relationships. I still judge relationships by whether trust survives pressure.",
      "en",
    );

    expect(new Set(round.items.map((item) => item.question)).size).toBe(round.items.length);
  });

  it("does not reintroduce fallback topics for invalidated themes", async () => {
    vi.spyOn(i18n, "resolvedLanguage", "get").mockReturnValue("en");
    vi.spyOn(i18n, "language", "get").mockReturnValue("en");
    const { buildDeterministicSummary } = await import("../../src/lib/reading-api");

    const summary = buildDeterministicSummary({
      locale: "en",
      text: "I care about work quality and conflict handling.",
      approvedAnchors: [],
      currentRoundItems: [],
      invalidQuestions: ["In this text, what kind of work style do I prefer?"],
    });

    expect(summary.missingTopics.some((topic) => /Work/i.test(topic))).toBe(false);
  });

  it("keeps overflow next-round candidates in the candidate pool", async () => {
    const { buildDeterministicNextRound } = await import("../../src/lib/reading-api");
    const result = buildDeterministicNextRound({
      locale: "en",
      text: "work and growth matter. ".repeat(200),
      approvedAnchors: [],
      reviewQueue: [],
      candidatePool: Array.from({ length: 18 }, (_, index) =>
        makeCandidate(
          `pool-${index}`,
          `theme-${Math.floor(index / 6)}`,
          `Theme ${Math.floor(index / 6)}`,
        ),
      ),
      selectedMissingTopics: ["Work trade-offs", "Long-term change", "Conflict handling"],
      extraFocus: "Keep exploring the same themes with more detail.",
      invalidQuestions: [],
    });

    expect(result.items.length).toBeLessThanOrEqual(18);
    expect(result.candidatePool.length).toBeGreaterThan(0);
  });

  it("marks the session closed and prevents auto-resume into a new round", () => {
    const { result } = renderHook(() => useReadingSession({ readingApi: seededReadingApi() }));
    act(() => result.current.hydrate(seedSummaryStageSession()));
    act(() => result.current.closeSession());

    expect(result.current.session?.status).toBe("closed");
    expect(result.current.session?.stage).toBe("closed");
  });

  it("resets a closed session so a fresh reading can start", () => {
    const { result } = renderHook(() => useReadingSession({ readingApi: seededReadingApi() }));
    act(() => result.current.hydrate(seedClosedSession()));

    act(() => result.current.resetSession());

    expect(result.current.session).toBeNull();
    expect(window.localStorage.getItem(READING_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("keeps a persisted closed session closed after reload", () => {
    window.localStorage.setItem(READING_SESSION_STORAGE_KEY, JSON.stringify(seedClosedSession()));
    const { result } = renderHook(() => useReadingSession({ readingApi: seededReadingApi() }));

    expect(result.current.session?.status).toBe("closed");
    expect(result.current.session?.stage).toBe("closed");
  });
});
