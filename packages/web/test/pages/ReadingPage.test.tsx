import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadingPage } from "../../src/pages/ReadingPage";
import type { ApiClient } from "../../src/lib/api-client";
import {
  cleanup,
  fireEvent,
  renderWithProviders,
  screen,
  userEvent,
  within,
} from "../helpers/test-utils";
import { READING_SESSION_STORAGE_KEY, type ReadingSession } from "../../src/lib/reading-session";

const seededLongText = "我很看重长期关系里的信任，也会在有冲突时明确边界。".repeat(40);

function makeSession(overrides?: Partial<ReadingSession>): ReadingSession {
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
          id: "item-1",
          question: "这段文本里，我在价值判断上最看重什么？",
          answer: "我最看重长期信任。",
          themeId: "theme-a",
          themeLabel: "价值观判断",
          score: 0.9,
          sourceSnippet: "source snippet",
          origin: "review",
          selection: null,
          correctionHint: "",
          isSourceOpen: false,
        },
        {
          id: "item-2",
          question: "这段文本里，我希望如何处理长期关系？",
          answer: "我会先建立稳定关系。",
          themeId: "theme-b",
          themeLabel: "长期关系",
          score: 0.8,
          origin: "new",
          selection: null,
          correctionHint: "",
          isSourceOpen: false,
        },
        {
          id: "item-3",
          question: "这段文本里，我处理冲突和边界时遵循什么原则？",
          answer: "我会直接说清楚边界。",
          themeId: "theme-c",
          themeLabel: "冲突处理",
          score: 0.7,
          origin: "new",
          selection: null,
          correctionHint: "",
          isSourceOpen: false,
        },
      ],
    },
    invalidQuestions: [],
    candidatePool: [],
    reviewQueue: [],
    approvedAnchors: [],
    submittedRounds: [],
    summary: null,
    ...overrides,
  };
}

function seedSummaryStageSession(): ReadingSession {
  return makeSession({
    stage: "summary",
    summary: {
      coveredTopics: ["价值观判断", "长期关系"],
      missingTopics: ["边界条件", "长期关系", "冲突处理"],
      selectedMissingTopics: [],
      extraFocus: "",
      invalidQuestions: [],
    },
  });
}

function seedQuestionnaireSessionWithReviewItems(): ReadingSession {
  return makeSession();
}

async function answerAllVisibleItems(user: ReturnType<typeof userEvent.setup>) {
  const radios = screen.getAllByRole("radio", { name: /认可|Approve/i });
  for (const radio of radios) {
    await user.click(radio);
  }
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("ReadingPage", () => {
  it("shows a soft warning below 800 chars but still allows start", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReadingPage />, { route: "/read" });

    await user.type(screen.getByLabelText(/长文本|Long text/i), "a".repeat(799));

    expect(screen.getByText(/这段文本有点短|This text is a bit short/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /开始阅读|Start reading/i })).toBeEnabled();
  });

  it("blocks start above 50000 chars", async () => {
    renderWithProviders(<ReadingPage />, { route: "/read" });

    fireEvent.change(screen.getByLabelText(/长文本|Long text/i), {
      target: { value: "a".repeat(50001) },
    });

    expect(screen.getByText(/50000 字以内|50000 characters or fewer/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /开始阅读|Start reading/i })).toBeDisabled();
  });

  it("starts reading through the owner reading API", async () => {
    const user = userEvent.setup();
    const post = vi.fn().mockResolvedValue({
      data: {
        items: [
          {
            id: "item-1",
            question: "这段文本里，我在价值判断上最看重什么？",
            answer: "我最看重长期信任。",
            themeId: "theme-a",
            themeLabel: "价值观判断",
            score: 0.9,
          },
        ],
        candidatePool: [],
      },
    });
    const apiClient = {
      ownerPath: (path: string) => `/api/mock-public-key${path}`,
      post,
      get: vi.fn(),
      put: vi.fn(),
      del: vi.fn(),
      streamPost: vi.fn(),
    } as unknown as ApiClient;

    renderWithProviders(<ReadingPage />, {
      route: "/read",
      authState: {
        apiClient,
      },
    });

    await user.type(screen.getByLabelText(/长文本|Long text/i), seededLongText);
    await user.click(screen.getByRole("button", { name: /开始阅读|Start reading/i }));

    expect(post).toHaveBeenCalledWith(
      "/api/mock-public-key/reading/start",
      expect.objectContaining({
        text: seededLongText,
        locale: expect.any(String),
      }),
    );
  });

  it("caps the input textarea height so the start button stays reachable", () => {
    renderWithProviders(<ReadingPage />, { route: "/read" });

    expect(screen.getByLabelText(/长文本|Long text/i)).toHaveStyle({ maxHeight: "400px" });
  });

  it("shows a reading loading hint while the first round is being generated", async () => {
    const user = userEvent.setup();
    const deferred: {
      resolve?: (value: { data: { items: never[]; candidatePool: never[] } }) => void;
    } = {};
    const post = vi.fn(
      () =>
        new Promise<{ data: { items: never[]; candidatePool: never[] } }>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    const apiClient = {
      ownerPath: (path: string) => `/api/mock-public-key${path}`,
      post,
      get: vi.fn(),
      put: vi.fn(),
      del: vi.fn(),
      streamPost: vi.fn(),
    } as unknown as ApiClient;

    renderWithProviders(<ReadingPage />, {
      route: "/read",
      authState: { apiClient },
    });

    await user.type(screen.getByLabelText(/长文本|Long text/i), seededLongText);
    await user.click(screen.getByRole("button", { name: /开始阅读|Start reading/i }));

    expect(screen.getByText(/Thinking\.\.\.|AI 正在阅读中/i)).toBeInTheDocument();

    if (deferred.resolve) {
      deferred.resolve({ data: { items: [], candidatePool: [] } });
    }
  });

  it("keeps start disabled for whitespace-only input", () => {
    renderWithProviders(<ReadingPage />, { route: "/read" });

    fireEvent.change(screen.getByLabelText(/长文本|Long text/i), {
      target: { value: "   \n  " },
    });

    expect(screen.getByRole("button", { name: /开始阅读|Start reading/i })).toBeDisabled();
  });

  it("blocks round submission until every questionnaire item is answered", () => {
    window.localStorage.setItem(READING_SESSION_STORAGE_KEY, JSON.stringify(makeSession()));
    renderWithProviders(<ReadingPage />, { route: "/read" });

    expect(screen.getByRole("button", { name: /提交本轮|Submit round/i })).toBeDisabled();
    expect(screen.getByText(/已完成 0|Answered 0/i)).toBeInTheDocument();
  });

  it("enables submission only after all visible items are answered", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(READING_SESSION_STORAGE_KEY, JSON.stringify(makeSession()));
    renderWithProviders(<ReadingPage />, { route: "/read" });

    await answerAllVisibleItems(user);

    expect(screen.getByRole("button", { name: /提交本轮|Submit round/i })).toBeEnabled();
  });

  it("shows a correction hint field only for answer-invalid items", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(READING_SESSION_STORAGE_KEY, JSON.stringify(makeSession()));
    renderWithProviders(<ReadingPage />, { route: "/read" });

    const firstCard = screen
      .getAllByText(/这段文本里/i)[0]
      ?.closest("[data-slot='card']") as HTMLElement;
    await user.click(within(firstCard).getByRole("radio", { name: /答案不对|Answer is wrong/i }));

    expect(screen.getByPlaceholderText(/偏差在|what is off/i)).toBeInTheDocument();
  });

  it("still allows round submission when answer-invalid items omit a correction hint", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(READING_SESSION_STORAGE_KEY, JSON.stringify(makeSession()));
    renderWithProviders(<ReadingPage />, { route: "/read" });

    const cards = screen
      .getAllByText(/这段文本里/i)
      .map((node) => node.closest("[data-slot='card']") as HTMLElement | null);
    const firstCard = cards[0];
    if (!firstCard) {
      throw new Error("expected questionnaire card");
    }

    await user.click(within(firstCard).getByRole("radio", { name: /答案不对|Answer is wrong/i }));
    await user.click(screen.getAllByRole("radio", { name: /认可|Approve/i })[1]);
    await user.click(screen.getAllByRole("radio", { name: /认可|Approve/i })[2]);

    expect(screen.getByRole("button", { name: /提交本轮|Submit round/i })).toBeEnabled();
  });

  it("shows a single source snippet when available and degrades locally when it is missing", async () => {
    const user = userEvent.setup();
    const session = makeSession();
    session.currentRound.items[1].sourceSnippet = undefined;
    window.localStorage.setItem(READING_SESSION_STORAGE_KEY, JSON.stringify(session));
    renderWithProviders(<ReadingPage />, { route: "/read" });

    const cards = screen
      .getAllByText(/这段文本里/i)
      .map((node) => node.closest("[data-slot='card']") as HTMLElement | null);
    const firstCard = cards[0];
    const secondCard = cards[1];
    if (!firstCard || !secondCard) {
      throw new Error("expected questionnaire cards");
    }

    await user.click(within(firstCard).getByRole("button", { name: /查看原文|View source/i }));
    expect(within(firstCard).getByText(/source snippet/i)).toBeInTheDocument();

    await user.click(within(secondCard).getByRole("button", { name: /查看原文|View source/i }));
    expect(
      within(secondCard).getByText(/暂时无法定位片段|Could not locate a source snippet/i),
    ).toBeInTheDocument();
  });

  it("shows covered topics, 3-5 missing-topic suggestions, and free-text focus after submit", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      READING_SESSION_STORAGE_KEY,
      JSON.stringify(seedSummaryStageSession()),
    );
    renderWithProviders(<ReadingPage />, { route: "/read" });

    expect(await screen.findByText(/已覆盖主题|Covered topics/i)).toBeInTheDocument();
    const suggestionButtons = screen.getAllByRole("button", {
      name: /边界条件|长期关系|冲突处理|Boundaries|Long-term relationships|Conflict handling/i,
    });
    expect(suggestionButtons.length).toBeGreaterThanOrEqual(3);
    expect(suggestionButtons.length).toBeLessThanOrEqual(5);
    expect(screen.getByLabelText(/补充关注点|Add focus/i)).toBeInTheDocument();

    await user.click(suggestionButtons[0]);
    await user.type(screen.getByLabelText(/补充关注点|Add focus/i), "如何处理长期冲突");
  });

  it("closes the session when the user chooses already enough", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      READING_SESSION_STORAGE_KEY,
      JSON.stringify(seedSummaryStageSession()),
    );
    renderWithProviders(<ReadingPage />, { route: "/read" });

    await user.click(screen.getByRole("button", { name: /已经足够|Already enough/i }));

    expect(screen.getByText(/本次阅读已结束|Reading session closed/i)).toBeInTheDocument();
  });

  it("persists approved anchors only after submit", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(READING_SESSION_STORAGE_KEY, JSON.stringify(makeSession()));
    const post = vi.fn(async (path: string) => {
      if (path.endsWith("/reading/summarize")) {
        return {
          data: {
            coveredTopics: ["价值观判断", "长期关系"],
            missingTopics: ["边界条件", "冲突处理", "工作取舍"],
          },
        };
      }

      if (path.endsWith("/anchors")) {
        return { data: { ok: true } };
      }

      throw new Error(`unexpected path: ${path}`);
    });
    const apiClient = {
      ownerPath: (path: string) => `/api/mock-public-key${path}`,
      post,
      get: vi.fn(),
      put: vi.fn(),
      del: vi.fn(),
      streamPost: vi.fn(),
    } as unknown as ApiClient;

    renderWithProviders(<ReadingPage />, {
      route: "/read",
      authState: {
        apiClient,
      },
    });

    await answerAllVisibleItems(user);
    await user.click(screen.getByRole("button", { name: /提交本轮|Submit round/i }));

    expect(post).toHaveBeenCalledWith("/api/mock-public-key/reading/summarize", expect.any(Object));
    expect(post).toHaveBeenCalledWith(
      "/api/mock-public-key/anchors",
      expect.objectContaining({
        question: expect.any(String),
        answer: expect.any(String),
      }),
    );
  });

  it("lets the user start a new reading after closing a session", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      READING_SESSION_STORAGE_KEY,
      JSON.stringify({
        ...seedSummaryStageSession(),
        status: "closed",
        stage: "closed",
      }),
    );
    renderWithProviders(<ReadingPage />, { route: "/read" });

    await user.click(screen.getByRole("button", { name: /重新开始|Start new reading/i }));

    expect(screen.getByLabelText(/长文本|Long text/i)).toBeInTheDocument();
  });

  it("renders theme group headings and a review badge for review-queue items", () => {
    window.localStorage.setItem(
      READING_SESSION_STORAGE_KEY,
      JSON.stringify(seedQuestionnaireSessionWithReviewItems()),
    );
    renderWithProviders(<ReadingPage />, { route: "/read" });

    expect(screen.getByText(/价值观判断|Value judgments/i)).toBeInTheDocument();
    expect(screen.getByText(/答案待修正|Answer needs revision/i)).toBeInTheDocument();
  });
});
