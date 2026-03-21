// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";

const mockInit = vi.fn();
const mockGetPublicKey = vi.fn(() => "test-public-key");
const mockIsEphemeral = vi.fn(() => false);
const apiClientCtor = vi.fn();

vi.mock("@remi/client", () => ({
  KeyStore: vi.fn().mockImplementation(() => ({
    init: mockInit,
    getPublicKey: mockGetPublicKey,
    isEphemeral: mockIsEphemeral,
  })),
}));

vi.mock("../../src/lib/api-client", () => ({
  ApiClient: vi.fn().mockImplementation((config) => {
    apiClientCtor(config);
    return {
      ownerPath: vi.fn(),
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      del: vi.fn(),
      streamPost: vi.fn(),
    };
  }),
}));

describe("AuthProvider", () => {
  beforeEach(() => {
    mockInit.mockResolvedValue(undefined);
    apiClientCtor.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses window.location.origin when VITE_API_BASE is unset", async () => {
    const locationSpy = vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      origin: "https://demo.trycloudflare.com",
    });

    const { AuthProvider } = await import("../../src/hooks/use-auth");

    render(createElement(AuthProvider, null, createElement("div", null, "ready")));

    await waitFor(() => expect(screen.getByText("ready")).toBeTruthy());

    expect(apiClientCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://demo.trycloudflare.com",
      }),
    );

    locationSpy.mockRestore();
  });
});
