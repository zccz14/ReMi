import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderWithProviders, screen } from "../helpers/test-utils";
import { MePage } from "../../src/pages/MePage";
import { emptyPublicProfile } from "../../src/lib/profile";

const usePwaInstallMock = vi.fn();

vi.mock("../../src/hooks/use-pwa-install", () => ({
  usePwaInstall: () => usePwaInstallMock(),
}));

const API_BASE = "https://api.example.test";

function mockUsePwaInstall(
  overrides?: Partial<{
    isPwaMode: boolean;
    platform: "ios" | "android" | "desktop" | "unknown";
    isGuideOpen: boolean;
    shouldShowBrowserOpenHint: boolean;
    installOrShowGuide: () => Promise<void>;
    closeGuide: () => void;
  }>,
) {
  usePwaInstallMock.mockReturnValue({
    isPwaMode: false,
    platform: "unknown",
    isGuideOpen: false,
    shouldShowBrowserOpenHint: false,
    installOrShowGuide: vi.fn().mockResolvedValue(undefined),
    closeGuide: vi.fn(),
    ...overrides,
  });
}

function createProfile(
  overrides?: Partial<{
    displayName: string;
    bio: string;
    hasAvatar: boolean;
    avatarVersion: number | null;
    updatedAt: number | null;
  }>,
) {
  return {
    ...emptyPublicProfile,
    updatedAt: 1710000000000,
    ...overrides,
  };
}

function renderMePage(profileRequest: ReturnType<typeof vi.fn>) {
  return renderWithProviders(<MePage />, {
    authState: {
      apiClient: {
        get: profileRequest,
        post: vi.fn(),
        put: vi.fn(),
        del: vi.fn(),
        streamPost: vi.fn(),
        ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
      } as any,
    },
  });
}

afterEach(() => {
  cleanup();
  usePwaInstallMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("MePage", () => {
  beforeEach(() => {
    mockUsePwaInstall();
  });

  it("shows owner nickname, avatar, and bio on the me card", async () => {
    vi.stubEnv("VITE_API_BASE", API_BASE);
    renderMePage(
      vi.fn().mockResolvedValue({
        data: createProfile({
          displayName: "Nova",
          bio: "hello",
          hasAvatar: true,
          avatarVersion: 4,
        }),
      }),
    );

    expect(await screen.findByText("Nova")).toBeInTheDocument();
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Nova" })).toHaveAttribute(
      "src",
      `${API_BASE}/api/public/mock-public-key/profile/avatar?v=4`,
    );
  });

  it("falls back to truncated owner pubKey and hides bio when owner profile is empty", async () => {
    renderMePage(vi.fn().mockResolvedValue({ data: createProfile() }));

    expect(await screen.findByText("mock-p...-key")).toBeInTheDocument();
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
  });

  it("falls back to truncated owner pubKey and no bio when owner profile load fails", async () => {
    renderMePage(vi.fn().mockRejectedValue(new Error("boom")));

    expect(await screen.findByText("mock-p...-key")).toBeInTheDocument();
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
  });

  it("shows unknown-platform install fallback copy when the install guide is open", async () => {
    mockUsePwaInstall({
      isGuideOpen: true,
      platform: "unknown",
    });

    renderMePage(vi.fn().mockResolvedValue({ data: createProfile() }));

    expect(
      await screen.findByText("打开浏览器菜单，查找“安装应用”或“添加到主屏幕”。"),
    ).toBeInTheDocument();
  });
});
