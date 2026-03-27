import { useState } from "react";
import type { ApiClient } from "../../src/lib/api-client";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
  within,
} from "../helpers/test-utils";
import { MePage } from "../../src/pages/MePage";
import { emptyPublicProfile } from "../../src/lib/profile";

const usePwaInstallMock = vi.fn();
const usePwaUpdateMock = vi.fn();

vi.mock("../../src/hooks/use-pwa-install", () => ({
  usePwaInstall: () => usePwaInstallMock(),
}));

vi.mock("../../src/hooks/use-pwa-update", () => ({
  usePwaUpdate: () => usePwaUpdateMock(),
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

function mockUsePwaUpdate(
  overrides?: Partial<{
    hasUpdate: boolean;
    isApplying: boolean;
    applyUpdate: () => Promise<void>;
  }>,
) {
  usePwaUpdateMock.mockReturnValue({
    hasUpdate: false,
    isApplying: false,
    applyUpdate: vi.fn().mockResolvedValue(undefined),
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

function renderInteractiveInstallMePage(
  options?: Partial<{
    platform: InstallPlatform;
    shouldShowBrowserOpenHint: boolean;
  }>,
) {
  const installOrShowGuide = vi.fn();
  const closeGuide = vi.fn();

  function Harness() {
    const [isGuideOpen, setIsGuideOpen] = useState(false);

    usePwaInstallMock.mockImplementation(() => ({
      isPwaMode: false,
      platform: options?.platform ?? "unknown",
      isGuideOpen,
      shouldShowBrowserOpenHint: options?.shouldShowBrowserOpenHint ?? false,
      installOrShowGuide: vi.fn(async () => {
        installOrShowGuide();
        setIsGuideOpen(true);
      }),
      closeGuide: vi.fn(() => {
        closeGuide();
        setIsGuideOpen(false);
      }),
    }));

    return <MePage />;
  }

  const renderResult = renderWithProviders(<Harness />, {
    authState: {
      apiClient: createMockApiClient(
        vi.fn().mockResolvedValue({ data: createProfile() }),
      ) as unknown as ApiClient,
    },
  });

  return {
    ...renderResult,
    installOrShowGuide,
    closeGuide,
  };
}

afterEach(() => {
  cleanup();
  usePwaInstallMock.mockReset();
  usePwaUpdateMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("MePage", () => {
  beforeEach(() => {
    mockUsePwaInstall();
    mockUsePwaUpdate();
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

  it("renders the remaining me menu links without any /stats entry", async () => {
    renderResolvedMePage();

    await screen.findByText("mock-p...-key");

    const links = screen.getAllByRole("link");
    const hrefs = links.map((link) => link.getAttribute("href"));

    expect(hrefs).toEqual(["/anchors", "/share", "/settings"]);
    expect(screen.queryByRole("link", { name: /数据统计/i })).not.toBeInTheDocument();
    expect(hrefs).not.toContain("/stats");
  });

  it("opens the install dialog after CTA clicked", async () => {
    const user = userEvent.setup();
    const { installOrShowGuide } = renderInteractiveInstallMePage({ platform: "ios" });

    await user.click(await screen.findByRole("button", { name: "安装应用" }));

    expect(installOrShowGuide).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
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

    const dialog = await screen.findByRole("dialog");
    const steps = within(dialog).getAllByRole("listitem");
    expect(within(dialog).getByRole("heading", { name: "安装 ReMi" })).toBeInTheDocument();
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveTextContent(/Safari/);

    await user.click(within(dialog).getByRole("button", { name: "关闭" }));

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

    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(closeGuide).toHaveBeenCalledTimes(1));
  });

  it("shows unknown-platform install fallback copy when the install guide is open", async () => {
    mockUsePwaInstall({
      isGuideOpen: true,
      platform: "unknown",
    });

    renderResolvedMePage();

    const dialog = await screen.findByRole("dialog");
    const steps = within(dialog).getAllByRole("listitem");
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveTextContent(/打开浏览器菜单/);
    expect(
      within(dialog).getByText("如果没有看到安装选项，也可以继续在浏览器中使用 ReMi。"),
    ).toBeInTheDocument();
  });

  it("renders install dialog without steps when translation is missing", async () => {
    mockUsePwaInstall({
      isGuideOpen: true,
      platform: "broken" as InstallPlatform,
    });

    renderResolvedMePage();

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "安装 ReMi" })).toBeInTheDocument();
    expect(within(dialog).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("does not show update CTA when no update is available", async () => {
    renderResolvedMePage();

    await screen.findByText("mock-p...-key");

    expect(usePwaUpdateMock).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "立即更新" })).not.toBeInTheDocument();
  });

  it("shows update CTA when an update is available", async () => {
    mockUsePwaUpdate({ hasUpdate: true });

    renderResolvedMePage();

    expect(await screen.findByRole("button", { name: "立即更新" })).toBeInTheDocument();
  });

  it("calls applyUpdate when update CTA is clicked", async () => {
    const user = userEvent.setup();
    const applyUpdate = vi.fn().mockResolvedValue(undefined);
    mockUsePwaUpdate({ hasUpdate: true, applyUpdate });

    renderResolvedMePage();

    await user.click(await screen.findByRole("button", { name: "立即更新" }));

    expect(applyUpdate).toHaveBeenCalledTimes(1);
  });

  it("disables update CTA while applying", async () => {
    mockUsePwaUpdate({ hasUpdate: true, isApplying: true });

    renderResolvedMePage();

    const button = await screen.findByRole("button", { name: "更新中..." });
    expect(button).toBeDisabled();
    expect(screen.queryByRole("button", { name: "立即更新" })).not.toBeInTheDocument();
  });

  it("does not call applyUpdate twice while button is disabled", async () => {
    const user = userEvent.setup();
    const applyUpdate = vi.fn().mockResolvedValue(undefined);

    function Harness() {
      const [isApplying, setIsApplying] = useState(false);

      usePwaUpdateMock.mockImplementation(() => ({
        hasUpdate: true,
        isApplying,
        applyUpdate: vi.fn(async () => {
          applyUpdate();
          setIsApplying(true);
        }),
      }));

      return <MePage />;
    }

    renderWithProviders(<Harness />, {
      authState: {
        apiClient: createMockApiClient(
          vi.fn().mockResolvedValue({ data: createProfile() }),
        ) as unknown as ApiClient,
      },
    });

    const button = await screen.findByRole("button", { name: "立即更新" });
    await user.click(button);
    await user.click(screen.getByRole("button", { name: "更新中..." }));

    expect(applyUpdate).toHaveBeenCalledTimes(1);
  });
});
