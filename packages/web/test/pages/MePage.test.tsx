import type { ApiClient } from "../../src/lib/api-client";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderWithProviders, screen, userEvent, waitFor } from "../helpers/test-utils";
import { MePage } from "../../src/pages/MePage";
import { emptyPublicProfile } from "../../src/lib/profile";

const usePwaInstallMock = vi.fn();

vi.mock("../../src/hooks/use-pwa-install", () => ({
  usePwaInstall: () => usePwaInstallMock(),
}));

const API_BASE = "https://api.example.test";
type InstallPlatform = "ios" | "android" | "desktop" | "unknown";
type ProfileResponse = { data: typeof emptyPublicProfile };
type ProfileRequestMock = Mock<(path: string) => Promise<ProfileResponse>>;
type MePageApiClient = Pick<ApiClient, "get" | "post" | "put" | "del" | "streamPost" | "ownerPath">;

function mockUsePwaInstall(
  overrides?: Partial<{
    isPwaMode: boolean;
    platform: InstallPlatform;
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

function createMockApiClient(profileRequest: ProfileRequestMock) {
  return {
    get: profileRequest as unknown as ApiClient["get"],
    post: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
    streamPost: vi.fn(),
    ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
  } satisfies MePageApiClient;
}

function renderMePage(profileRequest: ProfileRequestMock) {
  return renderWithProviders(<MePage />, {
    authState: {
      apiClient: createMockApiClient(profileRequest) as unknown as ApiClient,
    },
  });
}

function renderResolvedMePage() {
  return renderMePage(vi.fn().mockResolvedValue({ data: createProfile() }));
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

  it("shows install CTA when running in browser mode", async () => {
    renderResolvedMePage();

    expect(await screen.findByRole("button", { name: "安装应用" })).toBeInTheDocument();
  });

  it("hides install CTA when already in PWA mode", async () => {
    mockUsePwaInstall({ isPwaMode: true });

    renderResolvedMePage();

    await screen.findByText("mock-p...-key");
    expect(screen.queryByRole("button", { name: "安装应用" })).not.toBeInTheDocument();
  });

  it("calls installOrShowGuide when CTA clicked", async () => {
    const installOrShowGuide = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    mockUsePwaInstall({ installOrShowGuide });

    renderResolvedMePage();

    await user.click(await screen.findByRole("button", { name: "安装应用" }));

    expect(installOrShowGuide).toHaveBeenCalledTimes(1);
  });

  it("renders iOS guidance and closes via translated footer button", async () => {
    const closeGuide = vi.fn();
    const user = userEvent.setup();
    mockUsePwaInstall({
      isGuideOpen: true,
      platform: "ios",
      closeGuide,
    });

    renderResolvedMePage();

    expect(await screen.findByText("安装 ReMi")).toBeInTheDocument();
    expect(screen.getByText("在 Safari 中点击分享按钮。")).toBeInTheDocument();
    expect(screen.getByText("选择“添加到主屏幕”，然后确认。")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "关闭" }));

    expect(closeGuide).toHaveBeenCalledTimes(1);
  });

  it("closes the dialog on dismissal path", async () => {
    const closeGuide = vi.fn();
    const user = userEvent.setup();
    mockUsePwaInstall({
      isGuideOpen: true,
      platform: "desktop",
      closeGuide,
    });

    renderResolvedMePage();

    expect(await screen.findByText("点击地址栏中的安装图标。")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(closeGuide).toHaveBeenCalledTimes(1));
  });

  it("shows unknown-platform install fallback copy when the install guide is open", async () => {
    mockUsePwaInstall({
      isGuideOpen: true,
      platform: "unknown",
    });

    renderResolvedMePage();

    expect(
      await screen.findByText("打开浏览器菜单，查找“安装应用”或“添加到主屏幕”。"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("如果没有看到安装选项，也可以继续在浏览器中使用 ReMi。"),
    ).toBeInTheDocument();
  });
});
