import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { renderWithProviders, cleanup, within } from "../helpers/test-utils";
import { MessageList } from "../../src/components/chat/MessageList";
import type { ChatMessage } from "../../src/hooks/use-chat";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

const sampleMessages: ChatMessage[] = [
  { id: 1, role: "user", content: "Hello", created_at: 1000 },
  { id: 2, role: "assistant", content: "Hi there!", created_at: 2000 },
  { id: 3, role: "user", content: "How are you?", created_at: 3000 },
];

describe("MessageList", () => {
  it("renders all messages", () => {
    const { container } = renderWithProviders(<MessageList messages={sampleMessages} />);
    const view = within(container);

    expect(view.getByText("Hello")).toBeInTheDocument();
    expect(view.getByText("Hi there!")).toBeInTheDocument();
    expect(view.getByText("How are you?")).toBeInTheDocument();
  });

  it("shows 'Load earlier messages' button when hasMore=true", () => {
    const onLoadMore = vi.fn();
    const { container } = renderWithProviders(
      <MessageList messages={sampleMessages} hasMore onLoadMore={onLoadMore} />,
    );
    const view = within(container);

    expect(view.getByText("Load earlier messages")).toBeInTheDocument();
  });

  it("hides load more button when hasMore=false", () => {
    const { container } = renderWithProviders(
      <MessageList messages={sampleMessages} hasMore={false} />,
    );
    const view = within(container);

    expect(view.queryByText("Load earlier messages")).not.toBeInTheDocument();
  });

  it("shows ThinkingBlock when thinking is provided", () => {
    const longThinking =
      "The model is thinking about this problem very carefully and considering multiple approaches to find the best answer.";
    const { container } = renderWithProviders(
      <MessageList messages={sampleMessages} thinking={longThinking} />,
    );
    const view = within(container);

    // ThinkingBlock shows truncated text by default (first 60 chars + "...")
    const truncated = longThinking.slice(0, 60) + "...";
    expect(view.getByText(truncated)).toBeInTheDocument();
  });
});
