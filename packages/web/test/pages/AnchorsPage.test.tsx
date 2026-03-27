import { describe, it, expect, afterEach, vi } from "vitest";
import { renderWithProviders, cleanup, userEvent } from "../helpers/test-utils";
import { AnchorsPage } from "../../src/pages/AnchorsPage";
import zhTranslations from "../../public/locales/zh/translation.json";

vi.mock("../../src/hooks/use-anchors", () => ({
  useAnchors: vi.fn(),
}));

import { useAnchors } from "../../src/hooks/use-anchors";

const mockUseAnchors = vi.mocked(useAnchors);
const anchorsTranslations = zhTranslations.anchors;

afterEach(cleanup);

function setupMock(overrides: Partial<ReturnType<typeof useAnchors>> = {}) {
  mockUseAnchors.mockReturnValue({
    anchors: [],
    total: 0,
    loading: false,
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    reload: vi.fn(),
    ...overrides,
  });
}

describe("AnchorsPage", () => {
  it("shows loading skeletons initially", () => {
    setupMock({ loading: true });

    const { getByTestId } = renderWithProviders(<AnchorsPage />);

    expect(getByTestId("anchors-loading")).toBeInTheDocument();
  });

  it("shows anchor cards with question, answer, and localized source badge", () => {
    setupMock({
      anchors: [
        {
          id: "1",
          question: "What is React?",
          answer: "A JS library",
          source: "manual",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: "2",
          question: "What is Vue?",
          answer: "Another framework",
          source: "interview",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });

    const { getByText } = renderWithProviders(<AnchorsPage />);
    expect(getByText("What is React?")).toBeInTheDocument();
    expect(getByText("A JS library")).toBeInTheDocument();
    expect(getByText(anchorsTranslations.source.manual)).toBeInTheDocument();
    expect(getByText("What is Vue?")).toBeInTheDocument();
    expect(getByText("Another framework")).toBeInTheDocument();
    expect(getByText(anchorsTranslations.source.interview)).toBeInTheDocument();
  });

  it("search input filters the displayed anchors", async () => {
    setupMock({
      total: 10,
      anchors: [
        {
          id: "1",
          question: "What is React?",
          answer: "A JS library",
          source: "manual",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: "2",
          question: "What is Vue?",
          answer: "Another framework",
          source: "interview",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });

    const { getByPlaceholderText, getByTestId, getByText, queryByText } = renderWithProviders(
      <AnchorsPage />,
    );

    const searchInput = getByPlaceholderText(anchorsTranslations.search);
    const user = userEvent.setup();
    await user.type(searchInput, "React");

    expect(getByText("What is React?")).toBeInTheDocument();
    expect(queryByText("What is Vue?")).not.toBeInTheDocument();
    expect(getByTestId("anchors-total")).toHaveTextContent("10");
  });

  it("shows total count from hook instead of filtered result count", () => {
    setupMock({
      total: 7,
      anchors: [
        {
          id: "1",
          question: "What is React?",
          answer: "A JS library",
          source: "manual",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: "2",
          question: "What is Vue?",
          answer: "Another framework",
          source: "interview",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });

    const { getByTestId } = renderWithProviders(<AnchorsPage />);

    expect(getByTestId("anchors-total")).toHaveTextContent("7");
  });

  it("shows localized created and updated timestamps for each anchor", () => {
    setupMock({
      total: 1,
      anchors: [
        {
          id: "1",
          question: "What is React?",
          answer: "A JS library",
          source: "manual",
          createdAt: new Date("2024-03-09T08:30:00Z").getTime(),
          updatedAt: new Date("2024-04-10T11:45:00Z").getTime(),
        },
      ],
    });

    const { getByText } = renderWithProviders(<AnchorsPage />);

    expect(
      getByText((content) => {
        const prefix = anchorsTranslations.createdAt.replace("{{value}}", "").trimEnd();
        return content.startsWith(prefix) && /\d{4}.*\d{1,2}:\d{2}/.test(content);
      }),
    ).toBeInTheDocument();
    expect(
      getByText((content) => {
        const prefix = anchorsTranslations.updatedAt.replace("{{value}}", "").trimEnd();
        return content.startsWith(prefix) && /\d{4}.*\d{1,2}:\d{2}/.test(content);
      }),
    ).toBeInTheDocument();
  });

  it("degrades invalid timestamps without crashing the page", () => {
    setupMock({
      total: 1,
      anchors: [
        {
          id: "1",
          question: "Broken time anchor",
          answer: "Still renders",
          source: "manual",
          createdAt: Number.NaN,
          updatedAt: new Date("2024-04-10T11:45:00Z").getTime(),
        },
      ],
    });

    const { getByText } = renderWithProviders(<AnchorsPage />);

    expect(getByText("Broken time anchor")).toBeInTheDocument();
    expect(
      getByText(
        anchorsTranslations.createdAt.replace("{{value}}", anchorsTranslations.invalidTime),
      ),
    ).toBeInTheDocument();
  });

  it("clicking '+' button shows add form", async () => {
    setupMock();

    const { getByTestId, getByPlaceholderText } = renderWithProviders(<AnchorsPage />);

    const addButton = getByTestId("add-anchor-button");
    const user = userEvent.setup();
    await user.click(addButton);

    expect(getByPlaceholderText(anchorsTranslations.question)).toBeInTheDocument();
    expect(getByPlaceholderText(anchorsTranslations.answer)).toBeInTheDocument();
  });
});
