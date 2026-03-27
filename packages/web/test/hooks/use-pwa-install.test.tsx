import { useState, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, userEvent, waitFor } from "../helpers/test-utils";
import type { BeforeInstallPromptEvent } from "../../src/lib/pwa-install";
import { PwaInstallProvider, usePwaInstall } from "../../src/hooks/use-pwa-install";

function installBrowserMocks() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      media: "",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  Object.defineProperty(window.navigator, "standalone", {
    configurable: true,
    writable: true,
    value: false,
  });
}

installBrowserMocks();

function setNavigatorState({
  userAgent = "Mozilla/5.0 Chrome/123.0.0.0 Safari/537.36",
  maxTouchPoints = 0,
  standalone = false,
}: {
  userAgent?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
} = {}) {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: userAgent,
  });

  Object.defineProperty(window.navigator, "maxTouchPoints", {
    configurable: true,
    value: maxTouchPoints,
  });

  Object.defineProperty(window.navigator, "standalone", {
    configurable: true,
    writable: true,
    value: standalone,
  });
}

function setStandaloneDisplayMode(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(display-mode: standalone)" ? matches : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function TestConsumer() {
  const {
    isGuideOpen,
    isPwaMode,
    platform,
    shouldShowBrowserOpenHint,
    installOrShowGuide,
    closeGuide,
  } = usePwaInstall();

  return (
    <>
      <div data-testid="guide-state">{String(isGuideOpen)}</div>
      <div data-testid="pwa-mode">{String(isPwaMode)}</div>
      <div data-testid="platform">{platform}</div>
      <div data-testid="browser-open-hint">{String(shouldShowBrowserOpenHint)}</div>
      <button type="button" onClick={() => void installOrShowGuide()}>
        install
      </button>
      <button type="button" onClick={closeGuide}>
        close
      </button>
    </>
  );
}

function renderWithProvider(children: ReactNode = <TestConsumer />) {
  return render(<PwaInstallProvider>{children}</PwaInstallProvider>);
}

function DeferredConsumerHarness() {
  const [isConsumerVisible, setIsConsumerVisible] = useState(false);

  return (
    <PwaInstallProvider>
      <button type="button" onClick={() => setIsConsumerVisible(true)}>
        mount consumer
      </button>
      {isConsumerVisible ? <TestConsumer /> : null}
    </PwaInstallProvider>
  );
}

function createBeforeInstallPromptEvent(options?: {
  promptImpl?: () => Promise<void>;
  userChoice?: Promise<{ outcome: "accepted" | "dismissed" }>;
}) {
  const event = new Event("beforeinstallprompt") as BeforeInstallPromptEvent;
  const prompt = vi.fn(options?.promptImpl ?? (() => Promise.resolve()));
  const preventDefault = vi.spyOn(event, "preventDefault");

  Object.defineProperty(event, "prompt", {
    configurable: true,
    value: prompt,
  });

  Object.defineProperty(event, "userChoice", {
    configurable: true,
    value: options?.userChoice ?? Promise.resolve({ outcome: "accepted" as const }),
  });

  return { event, prompt, preventDefault };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  installBrowserMocks();
  setNavigatorState();
  setStandaloneDisplayMode(false);
});

describe("PwaInstallProvider", () => {
  it("throws when usePwaInstall is used outside the provider", () => {
    expect(() => render(<TestConsumer />)).toThrow(
      "usePwaInstall must be used within PwaInstallProvider",
    );
  });

  it("reports pwa runtime when display mode is standalone", () => {
    setStandaloneDisplayMode(true);

    renderWithProvider();

    expect(screen.getByTestId("pwa-mode")).toHaveTextContent("true");
  });

  it("reports pwa runtime when navigator.standalone is true", () => {
    setNavigatorState({ standalone: true });

    renderWithProvider();

    expect(screen.getByTestId("pwa-mode")).toHaveTextContent("true");
  });

  it("exposes platform and browser-open hint fields from navigator signals", () => {
    setNavigatorState({
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/123.0.0.0 Mobile Safari/537.36 FBAV/400.0",
      maxTouchPoints: 5,
    });

    renderWithProvider();

    expect(screen.getByTestId("platform")).toHaveTextContent("android");
    expect(screen.getByTestId("browser-open-hint")).toHaveTextContent("true");
  });

  it("captures beforeinstallprompt at provider mount and uses cached event when install is clicked", async () => {
    renderWithProvider();
    const beforeInstallPrompt = createBeforeInstallPromptEvent();

    window.dispatchEvent(beforeInstallPrompt.event);

    await userEvent.click(screen.getByRole("button", { name: "install" }));

    expect(beforeInstallPrompt.preventDefault).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(beforeInstallPrompt.prompt).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("guide-state")).toHaveTextContent("false");
  });

  it("lets a consumer mounted after provider cached beforeinstallprompt use the cached event", async () => {
    render(<DeferredConsumerHarness />);
    const beforeInstallPrompt = createBeforeInstallPromptEvent();

    window.dispatchEvent(beforeInstallPrompt.event);
    await userEvent.click(screen.getByRole("button", { name: "mount consumer" }));
    await userEvent.click(screen.getByRole("button", { name: "install" }));

    await waitFor(() => expect(beforeInstallPrompt.prompt).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("guide-state")).toHaveTextContent("false");
  });

  it("falls back to guide when no prompt event exists", async () => {
    renderWithProvider();

    await userEvent.click(screen.getByRole("button", { name: "install" }));

    expect(screen.getByTestId("guide-state")).toHaveTextContent("true");
  });

  it("falls back to guide when prompt throws", async () => {
    renderWithProvider();
    const beforeInstallPrompt = createBeforeInstallPromptEvent({
      promptImpl: () => Promise.reject(new Error("prompt failed")),
    });

    window.dispatchEvent(beforeInstallPrompt.event);
    await userEvent.click(screen.getByRole("button", { name: "install" }));

    await waitFor(() => expect(beforeInstallPrompt.prompt).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("guide-state")).toHaveTextContent("true");
  });

  it("treats dismissed userChoice as non-error and allows later retry", async () => {
    renderWithProvider();
    const beforeInstallPrompt = createBeforeInstallPromptEvent({
      userChoice: Promise.resolve({ outcome: "dismissed" as const }),
    });

    window.dispatchEvent(beforeInstallPrompt.event);
    await userEvent.click(screen.getByRole("button", { name: "install" }));

    await waitFor(() => expect(beforeInstallPrompt.prompt).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("guide-state")).toHaveTextContent("false");

    await userEvent.click(screen.getByRole("button", { name: "install" }));

    expect(screen.getByTestId("guide-state")).toHaveTextContent("true");
  });

  it("clears prompt state and marks runtime installed after appinstalled", async () => {
    renderWithProvider();

    await userEvent.click(screen.getByRole("button", { name: "install" }));
    expect(screen.getByTestId("guide-state")).toHaveTextContent("true");

    const beforeInstallPrompt = createBeforeInstallPromptEvent();
    window.dispatchEvent(beforeInstallPrompt.event);
    window.dispatchEvent(new Event("appinstalled"));

    await waitFor(() => expect(screen.getByTestId("pwa-mode")).toHaveTextContent("true"));
    expect(screen.getByTestId("guide-state")).toHaveTextContent("false");

    await userEvent.click(screen.getByRole("button", { name: "install" }));

    expect(screen.getByTestId("guide-state")).toHaveTextContent("true");
    expect(beforeInstallPrompt.prompt).not.toHaveBeenCalled();
  });

  it("renders safely when browser globals are unavailable", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("document", undefined);

    expect(() => renderToString(<PwaInstallProvider>safe</PwaInstallProvider>)).not.toThrow();
  });
});
