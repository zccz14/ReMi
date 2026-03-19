import { describe, it, expect, vi, afterEach } from "vitest";
import { renderWithProviders, cleanup, within, userEvent } from "../helpers/test-utils";
import { ChatInput } from "../../src/components/chat/ChatInput";

afterEach(cleanup);

describe("ChatInput", () => {
  it("renders textarea and send button", () => {
    const onSend = vi.fn();
    const { container } = renderWithProviders(<ChatInput onSend={onSend} />);
    const view = within(container);

    expect(view.getByPlaceholderText("Type a message...")).toBeInTheDocument();
    expect(view.getByRole("button")).toBeInTheDocument();
  });

  it("types text into textarea and verifies value", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const { container } = renderWithProviders(<ChatInput onSend={onSend} />);
    const view = within(container);

    const textarea = view.getByPlaceholderText("Type a message...");
    await user.type(textarea, "hello world");
    expect(textarea).toHaveValue("hello world");
  });

  it("clicks send button, calls onSend with trimmed text, clears textarea", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const { container } = renderWithProviders(<ChatInput onSend={onSend} />);
    const view = within(container);

    const textarea = view.getByPlaceholderText("Type a message...");
    await user.type(textarea, "  hello  ");

    const button = view.getByRole("button");
    await user.click(button);

    expect(onSend).toHaveBeenCalledWith("hello");
    expect(textarea).toHaveValue("");
  });

  it("pressing Enter sends message", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const { container } = renderWithProviders(<ChatInput onSend={onSend} />);
    const view = within(container);

    const textarea = view.getByPlaceholderText("Type a message...");
    await user.type(textarea, "hi");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("hi");
  });

  it("pressing Shift+Enter does NOT send", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const { container } = renderWithProviders(<ChatInput onSend={onSend} />);
    const view = within(container);

    const textarea = view.getByPlaceholderText("Type a message...");
    await user.type(textarea, "hi");
    await user.keyboard("{Shift>}{Enter}{/Shift}");

    expect(onSend).not.toHaveBeenCalled();
  });

  it("when disabled, textarea and button are disabled", () => {
    const onSend = vi.fn();
    const { container } = renderWithProviders(<ChatInput onSend={onSend} disabled />);
    const view = within(container);

    expect(view.getByPlaceholderText("Type a message...")).toBeDisabled();
    expect(view.getByRole("button")).toBeDisabled();
  });

  it("send button disabled when textarea is empty", () => {
    const onSend = vi.fn();
    const { container } = renderWithProviders(<ChatInput onSend={onSend} />);
    const view = within(container);

    expect(view.getByRole("button")).toBeDisabled();
  });
});
