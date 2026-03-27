import type { ReactNode } from "react";
import { Outlet } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "../helpers/test-utils";

function mockPwaInstallProvider() {
  vi.doMock("../../src/hooks/use-pwa-install", async () => {
    const actual = await vi.importActual<typeof import("../../src/hooks/use-pwa-install")>(
      "../../src/hooks/use-pwa-install",
    );
    return {
      ...actual,
      PwaInstallProvider: ({ children }: { children: ReactNode }) => (
        <div data-testid="pwa-install-provider">{children}</div>
      ),
    };
  });
}

function mockSharedPages() {
  vi.doMock("../../src/components/layout/AppShell", () => ({
    AppShell: () => (
      <div>
        <div>app-shell</div>
        <Outlet />
      </div>
    ),
  }));

  vi.doMock("../../src/pages/MessagesPage", () => ({
    MessagesPage: () => <div>messages-page</div>,
  }));
  vi.doMock("../../src/pages/ContactsPage", () => ({
    ContactsPage: () => <div>contacts-page</div>,
  }));
  vi.doMock("../../src/pages/DiscoverPage", () => ({
    DiscoverPage: () => <div>discover-page</div>,
  }));
  vi.doMock("../../src/pages/MePage", () => ({ MePage: () => <div>me-page</div> }));
  vi.doMock("../../src/pages/RemiChatPage", () => ({
    RemiChatPage: () => <div>remi-chat-page</div>,
  }));
  vi.doMock("../../src/pages/AvatarChatPage", () => ({
    AvatarChatPage: () => <div>avatar-chat-page</div>,
  }));
  vi.doMock("../../src/pages/StatsPage", () => ({ StatsPage: () => <div>stats-page</div> }));
  vi.doMock("../../src/pages/AnchorsPage", () => ({ AnchorsPage: () => <div>anchors-page</div> }));
  vi.doMock("../../src/pages/SharePage", () => ({ SharePage: () => <div>share-page</div> }));
  vi.doMock("../../src/pages/SettingsPage", () => ({
    SettingsPage: () => <div>settings-page</div>,
  }));
}

function mockAppModules(authProvider: (props: { children: ReactNode }) => ReactNode) {
  mockPwaInstallProvider();

  vi.doMock("../../src/hooks/use-auth", async () => {
    const actual = await vi.importActual<typeof import("../../src/hooks/use-auth")>(
      "../../src/hooks/use-auth",
    );
    return {
      ...actual,
      AuthProvider: authProvider,
    };
  });

  vi.doMock("../../src/pages/ProfilePage", () => ({
    ProfilePage: () => <div>public-profile-page</div>,
  }));

  mockSharedPages();
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock("@remi/client");
  vi.doUnmock("../../src/hooks/use-auth");
  window.history.replaceState({}, "", "/");
});

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
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
}

describe("App", () => {
  it("renders the real public profile route without crashing outside AuthProvider", async () => {
    mockPwaInstallProvider();
    vi.doMock("@remi/client", () => ({
      KeyStore: vi.fn().mockImplementation(() => ({
        init: vi.fn().mockRejectedValue(new Error("identity exploded")),
        getPublicKey: vi.fn(() => "unused-public-key"),
        isEphemeral: vi.fn(() => false),
      })),
    }));
    mockSharedPages();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: {
            displayName: "Public Person",
            bio: "hello",
            hasAvatar: false,
            avatarVersion: null,
            updatedAt: null,
          },
        }),
      }),
    );
    window.history.replaceState({}, "", "/profile/test-public-key");

    const { default: App } = await import("../../src/App");

    render(<App />);

    expect(await screen.findByText("Public Person")).toBeInTheDocument();
    expect(screen.queryByText("identity exploded")).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("pwa-install-provider")).getByText("Public Person"),
    ).toBeInTheDocument();
  });

  it("keeps authenticated routes inside AuthProvider", async () => {
    mockAppModules(({ children }) => <div data-testid="auth-provider">{children}</div>);
    window.history.replaceState({}, "", "/messages");

    const { default: App } = await import("../../src/App");

    render(<App />);

    expect(screen.getByTestId("auth-provider")).toBeInTheDocument();
    expect(screen.getByText("messages-page")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("auth-provider")).getByText("messages-page"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("pwa-install-provider")).getByTestId("auth-provider"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("pwa-install-provider")).getByText("messages-page"),
    ).toBeInTheDocument();
  });
});
