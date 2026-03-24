import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "../../helpers/test-utils";
import { FullScreenLayout } from "../../../src/components/layout/FullScreenLayout";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FullScreenLayout", () => {
  it("renders non-string title content without changing header actions", () => {
    const onBack = vi.fn();

    render(
      <FullScreenLayout title={<span>custom-title</span>} onBack={onBack}>
        body
      </FullScreenLayout>,
    );

    expect(screen.getByText("custom-title")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.getByText("body")).toBeInTheDocument();
  });
});
