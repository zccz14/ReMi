import { describe, it, expect, afterEach, vi } from "vitest";
import { renderWithProviders, cleanup, userEvent } from "../helpers/test-utils";
import { AnchorsPage } from "../../src/pages/AnchorsPage";

vi.mock("../../src/hooks/use-anchors", () => ({
  useAnchors: vi.fn(),
}));

import { useAnchors } from "../../src/hooks/use-anchors";

const mockUseAnchors = vi.mocked(useAnchors);

afterEach(cleanup);

function setupMock(overrides: Partial<ReturnType<typeof useAnchors>> = {}) {
  mockUseAnchors.mockReturnValue({
    anchors: [],
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

    const { container } = renderWithProviders(<AnchorsPage />);
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("shows anchor cards with question and answer", () => {
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
    expect(getByText("What is Vue?")).toBeInTheDocument();
    expect(getByText("Another framework")).toBeInTheDocument();
  });

  it("search input filters the displayed anchors", async () => {
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

    const { getByPlaceholderText, getByText, queryByText } = renderWithProviders(<AnchorsPage />);

    const searchInput = getByPlaceholderText("anchors.search");
    const user = userEvent.setup();
    await user.type(searchInput, "React");

    expect(getByText("What is React?")).toBeInTheDocument();
    expect(queryByText("What is Vue?")).not.toBeInTheDocument();
  });

  it("clicking '+' button shows add form", async () => {
    setupMock();

    const { getByText, getByPlaceholderText } = renderWithProviders(<AnchorsPage />);

    const addButton = getByText(/\+/);
    const user = userEvent.setup();
    await user.click(addButton);

    expect(getByPlaceholderText("anchors.question")).toBeInTheDocument();
    expect(getByPlaceholderText("anchors.answer")).toBeInTheDocument();
  });
});
