import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "../../helpers/test-utils";
import { ChatAvatar } from "../../../src/components/chat/ChatAvatar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ChatAvatar", () => {
  it("renders the generated fallback when src is absent", () => {
    render(<ChatAvatar pubKey="abcdef1234567890" name="Nova" />);

    expect(screen.getByText("N")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Nova" })).not.toBeInTheDocument();
  });

  it("renders an image when src is provided", () => {
    render(<ChatAvatar pubKey="abcdef1234567890" name="Nova" src="/avatar.webp" />);

    expect(screen.getByRole("img", { name: "Nova" })).toHaveAttribute("src", "/avatar.webp");
  });

  it("preserves size and radius in image-backed mode", () => {
    render(<ChatAvatar pubKey="abcdef1234567890" name="Nova" src="/avatar.webp" size="lg" />);

    const image = screen.getByRole("img", { name: "Nova" });
    const wrapper = image.parentElement;

    expect(wrapper).toHaveStyle({ width: "72px", height: "72px", borderRadius: "14px" });
    expect(image).toHaveStyle({ borderRadius: "14px" });
  });

  it("falls back to generated avatar after image load failure", async () => {
    render(<ChatAvatar pubKey="abcdef1234567890" name="Nova" src="/avatar.webp" />);

    fireEvent.error(screen.getByRole("img", { name: "Nova" }));

    expect(await screen.findByText("N")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Nova" })).not.toBeInTheDocument();
  });

  it("resets image fallback when src changes", () => {
    const { rerender } = render(
      <ChatAvatar pubKey="abcdef1234567890" name="Nova" src="/avatar.webp" />,
    );

    fireEvent.error(screen.getByRole("img", { name: "Nova" }));
    expect(screen.queryByRole("img", { name: "Nova" })).not.toBeInTheDocument();

    rerender(<ChatAvatar pubKey="abcdef1234567890" name="Nova" src="/avatar-2.webp" />);

    expect(screen.getByRole("img", { name: "Nova" })).toHaveAttribute("src", "/avatar-2.webp");
  });

  it("preserves click and keyboard activation when image-backed", () => {
    const onClick = vi.fn();

    render(
      <ChatAvatar pubKey="abcdef1234567890" name="Nova" src="/avatar.webp" onClick={onClick} />,
    );

    const avatarButton = screen.getByRole("button", { name: "Nova" });

    fireEvent.click(avatarButton);
    fireEvent.keyDown(avatarButton, { key: "Enter" });
    fireEvent.keyDown(avatarButton, { key: " " });

    expect(onClick).toHaveBeenCalledTimes(3);
  });
});
