import { describe, it, expect, afterEach } from "vitest";
import { renderWithProviders, cleanup, userEvent } from "../helpers/test-utils";
import { SettingsPage } from "../../src/pages/SettingsPage";

afterEach(cleanup);

describe("SettingsPage", () => {
  it("displays the public key", () => {
    const { getByText } = renderWithProviders(<SettingsPage />);
    expect(getByText("mock-public-key")).toBeInTheDocument();
  });

  it("clicking export toggles private key visibility", async () => {
    const { getByText, queryByText } = renderWithProviders(<SettingsPage />);

    // Private key should not be visible initially
    expect(queryByText("mock-private-key")).not.toBeInTheDocument();

    const user = userEvent.setup();
    const exportButton = getByText("settings.exportKey");
    await user.click(exportButton);

    // Private key should now be visible
    expect(getByText("mock-private-key")).toBeInTheDocument();

    // Click again to hide
    await user.click(exportButton);
    expect(queryByText("mock-private-key")).not.toBeInTheDocument();
  });

  it("shows import input field", () => {
    const { getByPlaceholderText } = renderWithProviders(<SettingsPage />);
    expect(getByPlaceholderText("settings.importPlaceholder")).toBeInTheDocument();
  });
});
