import { describe, it, expect, afterEach } from "vitest";
import { renderWithProviders, cleanup, within } from "../helpers/test-utils";
import { EphemeralWarning } from "../../src/components/common/EphemeralWarning";

afterEach(cleanup);

describe("EphemeralWarning", () => {
  it("renders the warning text (translated)", () => {
    const { container } = renderWithProviders(<EphemeralWarning />);
    const view = within(container);

    expect(view.getByText("临时身份警告")).toBeInTheDocument();
  });

  it("accepts and applies className prop", () => {
    const { container } = renderWithProviders(<EphemeralWarning className="extra-class" />);

    const div = container.firstChild as HTMLElement;
    expect(div.className).toContain("extra-class");
  });
});
