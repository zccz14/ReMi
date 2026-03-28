import { describe, expect, it } from "vitest";
import {
  composeNextRound,
  countReadingChars,
  READING_SESSION_TTL_MS,
  restoreReadingSession,
  type ApprovedReadingAnchor,
  type ReadingCandidate,
} from "../../src/lib/reading-session";

function review(id: string, themeId = "theme-a"): ReadingCandidate {
  return {
    id,
    question: `question-${id}`,
    answer: `answer-${id}`,
    themeId,
    themeLabel: themeId,
    score: 1,
    origin: "review",
  };
}

function candidate(id: string, themeId = "theme-b", score = 0.5): ReadingCandidate {
  return {
    id,
    question: `question-${id}`,
    answer: `answer-${id}`,
    themeId,
    themeLabel: themeId,
    score,
    origin: "new",
  };
}

function approved(id: string): ApprovedReadingAnchor {
  return {
    id,
    question: `question-${id}`,
    answer: `answer-${id}`,
    themeId: "theme-z",
    themeLabel: "theme-z",
  };
}

describe("reading-session helpers", () => {
  it("counts input length with UTF-16 length semantics", () => {
    expect(countReadingChars("a\n🙂")).toBe("a\n🙂".length);
  });

  it("keeps review items first and enforces round and theme caps", () => {
    const result = composeNextRound({
      approvedAnchors: [approved("approved")],
      reviewQueue: [review("a-1", "theme-a"), review("a-2", "theme-a"), review("a-3", "theme-a")],
      candidatePool: [candidate("b-1", "theme-b", 0.9), candidate("c-1", "theme-c", 0.8)],
      maxItems: 4,
      maxPerTheme: 2,
    });

    expect(result.items.map((item) => item.id)).toEqual(["a-1", "a-2", "b-1", "c-1"]);
    expect(result.deferredReviewQueue.map((item) => item.id)).toEqual(["a-3"]);
  });

  it("drops expired sessions older than the ttl", () => {
    const restored = restoreReadingSession(
      JSON.stringify({
        locale: "zh",
        status: "active",
        stage: "questionnaire",
        text: "hello",
        createdAt: 1,
        updatedAt: 1,
        currentRound: { index: 1, items: [] },
        invalidQuestions: [],
        candidatePool: [],
        reviewQueue: [],
        approvedAnchors: [],
        submittedRounds: [],
        summary: null,
      }),
      1 + READING_SESSION_TTL_MS + 1,
    );

    expect(restored).toBeNull();
  });
});
