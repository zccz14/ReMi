// @vitest-environment jsdom
import { createElement } from "react";
import { describe, it, expect, afterEach } from "vitest";
import { renderWithProviders, cleanup, within } from "../helpers/test-utils";
import { ProcessPanel } from "../../src/components/chat/ProcessPanel";

afterEach(cleanup);

describe("ProcessPanel", () => {
  it("does not render when idle and empty", () => {
    const { container } = renderWithProviders(
      createElement(ProcessPanel, { phase: "idle", thinkingItems: [] }),
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders current phase and timeline items", () => {
    const { container } = renderWithProviders(
      createElement(ProcessPanel, {
        phase: "extracting",
        thinkingItems: ["scan profile", "collect context"],
      }),
    );
    const view = within(container);

    expect(view.getByText("Process")).toBeTruthy();
    expect(view.getByText("Extracting")).toBeTruthy();
    expect(view.getByText("• scan profile")).toBeTruthy();
    expect(view.getByText("• collect context")).toBeTruthy();
  });
});
