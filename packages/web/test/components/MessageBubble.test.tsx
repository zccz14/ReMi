import { describe, it, expect, afterEach } from "vitest";
import { renderWithProviders, cleanup, within } from "../helpers/test-utils";
import { MessageBubble } from "../../src/components/chat/MessageBubble";

afterEach(cleanup);

describe("MessageBubble", () => {
  it("user message has justify-end (right-aligned)", () => {
    const { container } = renderWithProviders(<MessageBubble role="user" content="Hello" />);

    const outer = container.firstChild as HTMLElement;
    expect(outer.className).toContain("justify-end");
  });

  it("assistant message has justify-start (left-aligned)", () => {
    const { container } = renderWithProviders(
      <MessageBubble role="assistant" content="Hi there" />,
    );

    const outer = container.firstChild as HTMLElement;
    expect(outer.className).toContain("justify-start");
  });

  it("renders content text correctly", () => {
    const { container } = renderWithProviders(
      <MessageBubble role="user" content="Test message content" />,
    );
    const view = within(container);

    expect(view.getByText("Test message content")).toBeInTheDocument();
  });
});
