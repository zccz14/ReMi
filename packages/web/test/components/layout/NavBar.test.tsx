// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, renderWithProviders, screen } from "../../helpers/test-utils";
import { NavBar } from "../../../src/components/layout/NavBar";

describe("NavBar", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("links the center tab to /approval/anchors by default", () => {
    renderWithProviders(<NavBar />, { route: "/messages" });

    expect(screen.getByRole("link", { name: /审批中心|Approval/i })).toHaveAttribute(
      "href",
      "/approval/anchors",
    );
  });

  it("links the center tab to the last visited approval path", () => {
    window.localStorage.setItem("remi.last-approval-path", "/approval/probes");

    renderWithProviders(<NavBar />, { route: "/contacts" });

    expect(screen.getByRole("link", { name: /审批中心|Approval/i })).toHaveAttribute(
      "href",
      "/approval/probes",
    );
  });
});
