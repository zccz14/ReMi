import { describe, it, expect, afterEach, vi } from "vitest";
import { renderWithProviders, cleanup } from "../helpers/test-utils";

vi.mock("qrcode.react", () => ({
  QRCodeSVG: (props: any) => <svg data-testid="qr-code" data-value={props.value} />,
}));

import { SharePage } from "../../src/pages/SharePage";

afterEach(cleanup);

describe("SharePage", () => {
  it("shows the share URL containing the public key", () => {
    const { getByText } = renderWithProviders(<SharePage />);
    // The share URL is: `${window.location.origin}/s/${publicKey}`
    // In jsdom, window.location.origin is "http://localhost"
    expect(getByText(/mock-public-key/)).toBeInTheDocument();
  });

  it("renders a QR code", () => {
    const { getByTestId } = renderWithProviders(<SharePage />);
    const qr = getByTestId("qr-code");
    expect(qr).toBeInTheDocument();
    expect(qr.getAttribute("data-value")).toContain("mock-public-key");
  });

  it("has a copy button", () => {
    const { getByText } = renderWithProviders(<SharePage />);
    expect(getByText("share.copyLink")).toBeInTheDocument();
  });
});
