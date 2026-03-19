import { describe, it, expect, afterEach } from "vitest";
import { renderWithProviders, cleanup, within, userEvent } from "../helpers/test-utils";
import { ThinkingBlock } from "../../src/components/chat/ThinkingBlock";

afterEach(cleanup);

const longNarrative =
  "This is a long narrative text that exceeds sixty characters to test the truncation behavior properly.";

describe("ThinkingBlock", () => {
  it("shows truncated text by default (first 60 chars + '...')", () => {
    const { container } = renderWithProviders(<ThinkingBlock narrative={longNarrative} />);
    const view = within(container);

    const truncated = longNarrative.slice(0, 60) + "...";
    expect(view.getByText(truncated)).toBeInTheDocument();
  });

  it("expands to show full text on click", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ThinkingBlock narrative={longNarrative} />);
    const view = within(container);

    const truncated = longNarrative.slice(0, 60) + "...";
    await user.click(view.getByText(truncated));

    expect(view.getByText(longNarrative)).toBeInTheDocument();
  });

  it("collapses back on second click", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ThinkingBlock narrative={longNarrative} />);
    const view = within(container);

    const truncatedText = longNarrative.slice(0, 60) + "...";

    // Expand
    await user.click(view.getByText(truncatedText));
    expect(view.getByText(longNarrative)).toBeInTheDocument();

    // Collapse
    await user.click(view.getByText(longNarrative));
    expect(view.getByText(truncatedText)).toBeInTheDocument();
  });
});
