import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "../helpers/test-utils";
import { DiscoverPage } from "../../src/pages/DiscoverPage";

describe("DiscoverPage", () => {
  it("shows the reading entry and links to /read", () => {
    renderWithProviders(<DiscoverPage />, { route: "/discover" });

    const link = screen.getByRole("link", { name: /阅读|Reading/i });
    expect(link).toHaveAttribute("href", "/read");
    expect(
      screen.getByText(
        /发现其他用户，浏览社区，也发现自己|Discover users, browse community, and discover yourself/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/把一段长文本交给 AI|Give AI a long text/i)).toBeInTheDocument();
  });
});
