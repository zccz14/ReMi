# PWA Install CTA Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ReMi Web 的 `【我】` 页面增加一个仅在非 PWA 环境显示的 `安装 PWA 应用` 按钮，优先触发原生安装，失败时回退到平台化手动安装说明。

**Architecture:** 在应用最顶层新增一个 PWA 安装状态 Provider，尽早监听并缓存 `beforeinstallprompt`，统一暴露 `isPwaMode`、平台识别结果、受限宿主提示和 `installOrShowGuide()` 动作。`【我】` 页面只消费这个状态并渲染一个最小按钮入口，安装说明由独立弹窗组件负责，所有用户可见文案统一进入 i18n，测试环境也补同结构的最小翻译资源。

**Tech Stack:** React 19, React Router 7, i18next, Base UI dialog, Vitest, Testing Library, Vite PWA

---

## 文件结构

- Create: `packages/web/src/lib/pwa-install.ts` — PWA 运行态检测、平台识别、受限宿主提示、安装事件类型
- Create: `packages/web/src/types/pwa-install.d.ts` — 收口非标准浏览器 API 类型声明，避免散落类型断言
- Create: `packages/web/src/hooks/use-pwa-install.tsx` — Provider + context，顶层监听安装事件并暴露安装动作
- Create: `packages/web/src/components/pwa/PwaInstallDialog.tsx` — 平台化安装说明弹窗与国际化关闭按钮
- Modify: `packages/web/src/App.tsx` — 在应用最顶层挂载 PWA 安装 Provider，覆盖 public route 和 authenticated route
- Modify: `packages/web/src/pages/MePage.tsx` — 在 `【我】` 页面渲染最小安装按钮并接入弹窗
- Modify: `packages/web/public/locales/zh/translation.json` — 新增中文安装按钮与平台说明文案
- Modify: `packages/web/public/locales/en/translation.json` — 新增英文安装按钮与平台说明文案
- Modify: `packages/web/test/helpers/test-utils.tsx` — 为测试环境补最小 `me.install` 资源，保证页面测试可断言真实文案
- Create: `packages/web/test/lib/pwa-install.test.ts` — 纯函数测试：PWA 检测、平台识别、未知平台回退、受限宿主提示
- Create: `packages/web/test/hooks/use-pwa-install.test.tsx` — Provider 行为测试：顶层监听、失败回退、dismiss 路径与安装完成清理
- Modify: `packages/web/test/pages/MePage.test.tsx` — 按钮显示/隐藏、按钮点击和说明弹窗关闭测试
- Modify: `packages/web/test/pages/App.test.tsx` — 确认 Provider 在应用最顶层包裹路由树

说明：用户已经明确要求“边做边提交”且“不使用 worktree”。执行本计划时直接在当前分支按 task 或 chunk 提交，不新建 worktree。

## Chunk 1: 纯逻辑、顶层安装状态与根层接线

### Task 1: 先写纯函数测试，再定义安装工具模块

**Files:**

- Create: `packages/web/src/lib/pwa-install.ts`
- Create: `packages/web/test/lib/pwa-install.test.ts`

- [ ] **Step 1: 写 PWA 运行态与平台识别的失败测试**

```ts
import { describe, expect, it } from "vitest";
import {
  detectPwaMode,
  detectInstallPlatform,
  shouldPreferBrowserOpenHint,
} from "../../src/lib/pwa-install";

describe("pwa-install helpers", () => {
  it("treats standalone display mode as PWA runtime", () => {
    expect(detectPwaMode({ standaloneMatch: true, navigatorStandalone: false, referrer: "" })).toBe(
      true,
    );
  });

  it("treats iOS navigator.standalone as PWA runtime", () => {
    expect(detectPwaMode({ standaloneMatch: false, navigatorStandalone: true, referrer: "" })).toBe(
      true,
    );
  });

  it("falls back to browser mode when no runtime signal exists", () => {
    expect(
      detectPwaMode({ standaloneMatch: false, navigatorStandalone: false, referrer: "" }),
    ).toBe(false);
  });

  it("detects ios, android, desktop, and unknown install platforms", () => {
    expect(
      detectInstallPlatform({
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1",
        maxTouchPoints: 5,
      }),
    ).toBe("ios");

    expect(
      detectInstallPlatform({
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/123.0.0.0 Mobile Safari/537.36",
        maxTouchPoints: 5,
      }),
    ).toBe("android");

    expect(
      detectInstallPlatform({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36",
        maxTouchPoints: 0,
      }),
    ).toBe("desktop");

    expect(
      detectInstallPlatform({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15",
        maxTouchPoints: 5,
      }),
    ).toBe("unknown");
  });

  it("requests browser-open guidance for restricted hosts", () => {
    expect(shouldPreferBrowserOpenHint("fbav/400.0")).toBe(true);
    expect(shouldPreferBrowserOpenHint("MicroMessenger/8.0.1")).toBe(true);
    expect(shouldPreferBrowserOpenHint("Mozilla/5.0 Chrome/123.0.0.0")).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试，确认先失败**

Run: `npx vitest run packages/web/test/lib/pwa-install.test.ts --config packages/web/vite.config.ts`

Expected: FAIL，原因应指向缺失的 `pwa-install` 模块或未导出的函数。

- [ ] **Step 3: 写最小工具模块实现**

```ts
export type InstallPlatform = "ios" | "android" | "desktop" | "unknown";

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice?: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface PwaRuntimeSignals {
  standaloneMatch: boolean;
  navigatorStandalone: boolean;
  referrer: string;
}

export interface PlatformSignals {
  userAgent: string;
  maxTouchPoints: number;
}

export function detectPwaMode({
  standaloneMatch,
  navigatorStandalone,
  referrer,
}: PwaRuntimeSignals): boolean {
  return standaloneMatch || navigatorStandalone || referrer.includes("android-app://");
}

export function detectInstallPlatform({
  userAgent,
  maxTouchPoints,
}: PlatformSignals): InstallPlatform {
  const ua = userAgent.toLowerCase();
  if (/iphone|ipod|ipad/.test(ua)) return "ios";
  if (ua.includes("android")) return "android";
  if (ua.includes("macintosh") && maxTouchPoints > 1) return "unknown";
  if (/macintosh|windows|linux/.test(ua)) return "desktop";
  return "unknown";
}

export function shouldPreferBrowserOpenHint(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  return ua.includes("fbav") || ua.includes("instagram") || ua.includes("micromessenger");
}
```

- [ ] **Step 4: 运行纯函数测试，确认通过**

Run: `npx vitest run packages/web/test/lib/pwa-install.test.ts --config packages/web/vite.config.ts`

Expected: PASS with all helper tests green.

- [ ] **Step 5: 提交纯函数基础**

```bash
git add packages/web/src/lib/pwa-install.ts packages/web/test/lib/pwa-install.test.ts
git commit -m "feat: add PWA install helpers"
```

### Task 2: 先写 Provider 行为测试，再实现顶层监听和安装动作

**Files:**

- Create: `packages/web/src/types/pwa-install.d.ts`
- Create: `packages/web/src/hooks/use-pwa-install.tsx`
- Create: `packages/web/test/hooks/use-pwa-install.test.tsx`

- [ ] **Step 1: 先在测试文件里补浏览器 mock 并写失败测试**

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, userEvent } from "../helpers/test-utils";
import { PwaInstallProvider, usePwaInstall } from "../../src/hooks/use-pwa-install";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockReturnValue({
    matches: false,
    media: "(display-mode: standalone)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

Object.defineProperty(window.navigator, "standalone", {
  configurable: true,
  value: false,
});

class MockBeforeInstallPromptEvent extends Event {
  prompt = vi.fn().mockResolvedValue(undefined);
  userChoice = Promise.resolve({ outcome: "dismissed" as const });
  preventDefault = vi.fn();

  constructor() {
    super("beforeinstallprompt");
  }
}

class RejectingBeforeInstallPromptEvent extends Event {
  prompt = vi.fn().mockRejectedValue(new Error("expired"));
  userChoice = Promise.resolve({ outcome: "dismissed" as const });
  preventDefault = vi.fn();

  constructor() {
    super("beforeinstallprompt");
  }
}

class DismissedBeforeInstallPromptEvent extends Event {
  prompt = vi.fn().mockResolvedValue(undefined);
  userChoice = Promise.resolve({ outcome: "dismissed" as const });
  preventDefault = vi.fn();

  constructor() {
    super("beforeinstallprompt");
  }
}

function Probe() {
  const state = usePwaInstall();
  return (
    <>
      <div data-testid="mode">{state.isPwaMode ? "pwa" : "browser"}</div>
      <div data-testid="platform">{state.platform}</div>
      <div data-testid="dialog">{state.isGuideOpen ? "open" : "closed"}</div>
      <button onClick={() => void state.installOrShowGuide()}>install</button>
      <button onClick={state.closeGuide}>close</button>
    </>
  );
}

describe("PwaInstallProvider", () => {
  it("captures beforeinstallprompt at provider mount", async () => {
    render(
      <PwaInstallProvider>
        <Probe />
      </PwaInstallProvider>,
    );

    const installEvent = new MockBeforeInstallPromptEvent();
    window.dispatchEvent(installEvent);

    await userEvent.click(screen.getByRole("button", { name: "install" }));

    await waitFor(() => {
      expect(installEvent.preventDefault).toHaveBeenCalled();
      expect(installEvent.prompt).toHaveBeenCalled();
    });
  });

  it("falls back to guide when there is no prompt event", async () => {
    render(
      <PwaInstallProvider>
        <Probe />
      </PwaInstallProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "install" }));

    expect(screen.getByTestId("dialog")).toHaveTextContent("open");
  });

  it("falls back to guide when prompt() throws", async () => {
    render(
      <PwaInstallProvider>
        <Probe />
      </PwaInstallProvider>,
    );

    window.dispatchEvent(new RejectingBeforeInstallPromptEvent());
    await userEvent.click(screen.getByRole("button", { name: "install" }));

    await waitFor(() => {
      expect(screen.getByTestId("dialog")).toHaveTextContent("open");
    });
  });

  it("treats dismissed userChoice as a non-error and allows later retry", async () => {
    render(
      <PwaInstallProvider>
        <Probe />
      </PwaInstallProvider>,
    );

    window.dispatchEvent(new DismissedBeforeInstallPromptEvent());
    await userEvent.click(screen.getByRole("button", { name: "install" }));

    expect(screen.getByTestId("dialog")).toHaveTextContent("closed");

    await userEvent.click(screen.getByRole("button", { name: "install" }));

    expect(screen.getByTestId("dialog")).toHaveTextContent("open");
  });

  it("clears prompt state and marks runtime installed after appinstalled", async () => {
    render(
      <PwaInstallProvider>
        <Probe />
      </PwaInstallProvider>,
    );

    window.dispatchEvent(new Event("appinstalled"));

    await waitFor(() => {
      expect(screen.getByTestId("mode")).toHaveTextContent("pwa");
      expect(screen.getByTestId("dialog")).toHaveTextContent("closed");
    });
  });
});
```

- [ ] **Step 2: 运行测试，确认先失败**

Run: `npx vitest run packages/web/test/hooks/use-pwa-install.test.tsx --config packages/web/vite.config.ts`

Expected: FAIL，原因应指向缺失的 Provider/hook 或行为不满足测试，而不是测试环境缺浏览器 mock。

- [ ] **Step 3: 写类型声明并实现最小 Provider**

先新增 `packages/web/src/types/pwa-install.d.ts`：

```ts
interface Navigator {
  standalone?: boolean;
}
```

再实现 `packages/web/src/hooks/use-pwa-install.tsx`：

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  detectInstallPlatform,
  detectPwaMode,
  shouldPreferBrowserOpenHint,
  type BeforeInstallPromptEvent,
  type InstallPlatform,
} from "../lib/pwa-install";

interface PwaInstallContextValue {
  isPwaMode: boolean;
  platform: InstallPlatform;
  isGuideOpen: boolean;
  shouldShowBrowserOpenHint: boolean;
  installOrShowGuide: () => Promise<void>;
  closeGuide: () => void;
}

const PwaInstallContext = createContext<PwaInstallContextValue | null>(null);

export function PwaInstallProvider({ children }: { children: ReactNode }) {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [isGuideOpen, setGuideOpen] = useState(false);
  const [installed, setInstalled] = useState(false);

  const platform = useMemo(
    () =>
      detectInstallPlatform({
        userAgent: navigator.userAgent,
        maxTouchPoints: navigator.maxTouchPoints ?? 0,
      }),
    [],
  );

  const shouldShowBrowserOpenHint = useMemo(
    () => shouldPreferBrowserOpenHint(navigator.userAgent),
    [],
  );

  const isPwaMode =
    installed ||
    detectPwaMode({
      standaloneMatch: window.matchMedia("(display-mode: standalone)").matches,
      navigatorStandalone: window.navigator.standalone === true,
      referrer: document.referrer,
    });

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      const typedEvent = event as BeforeInstallPromptEvent;
      typedEvent.preventDefault();
      setPromptEvent(typedEvent);
    };

    const onAppInstalled = () => {
      setInstalled(true);
      setPromptEvent(null);
      setGuideOpen(false);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  const installOrShowGuide = useCallback(async () => {
    if (!promptEvent) {
      setGuideOpen(true);
      return;
    }

    const activePrompt = promptEvent;
    setPromptEvent(null);

    try {
      await activePrompt.prompt();
      await activePrompt.userChoice;
    } catch {
      setGuideOpen(true);
    }
  }, [promptEvent]);

  return (
    <PwaInstallContext.Provider
      value={{
        isPwaMode,
        platform,
        isGuideOpen,
        shouldShowBrowserOpenHint,
        installOrShowGuide,
        closeGuide: () => setGuideOpen(false),
      }}
    >
      {children}
    </PwaInstallContext.Provider>
  );
}

export function usePwaInstall() {
  const value = useContext(PwaInstallContext);
  if (!value) throw new Error("usePwaInstall must be used within PwaInstallProvider");
  return value;
}
```

- [ ] **Step 4: 运行 hook 测试，确认通过**

Run: `npx vitest run packages/web/test/hooks/use-pwa-install.test.tsx --config packages/web/vite.config.ts`

Expected: PASS with provider behavior covered, including dismiss and retry flow.

- [ ] **Step 5: 提交顶层安装状态实现**

```bash
git add packages/web/src/types/pwa-install.d.ts packages/web/src/hooks/use-pwa-install.tsx packages/web/test/hooks/use-pwa-install.test.tsx
git commit -m "feat: add PWA install provider"
```

### Task 3: 先写根层接线测试，再把 Provider 挂到应用最顶层

**Files:**

- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/test/pages/App.test.tsx`

- [ ] **Step 1: 在 `App` 测试里要求 Provider 真正包住路由树**

在 `packages/web/test/pages/App.test.tsx` 中加入 mock：

```tsx
vi.doMock("../../src/hooks/use-pwa-install", () => ({
  PwaInstallProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="pwa-install-provider">{children}</div>
  ),
}));
```

并增加两条断言：

```tsx
it("wraps authenticated routes with the top-level PWA install provider", async () => {
  mockAppModules(({ children }) => <div data-testid="auth-provider">{children}</div>);
  window.history.replaceState({}, "", "/messages");

  const { default: App } = await import("../../src/App");

  render(<App />);

  expect(screen.getByTestId("pwa-install-provider")).toContainElement(
    screen.getByTestId("auth-provider"),
  );
});

it("wraps public routes with the same top-level PWA install provider", async () => {
  mockSharedPages();
  window.history.replaceState({}, "", "/profile/test-public-key");

  const { default: App } = await import("../../src/App");

  render(<App />);

  expect(screen.getByTestId("pwa-install-provider")).toContainElement(
    screen.getByText("public-profile-page"),
  );
});
```

- [ ] **Step 2: 运行 `App` 测试，确认先失败**

Run: `npx vitest run packages/web/test/pages/App.test.tsx --config packages/web/vite.config.ts`

Expected: FAIL，原因应指向 `App.tsx` 还未在顶层挂载 `PwaInstallProvider`。

- [ ] **Step 3: 在 `App.tsx` 把 Provider 上提到最顶层**

```tsx
import { PwaInstallProvider } from "./hooks/use-pwa-install";

export default function App() {
  return (
    <Suspense
      fallback={<div className="flex items-center justify-center min-h-screen">Loading...</div>}
    >
      <BrowserRouter>
        <TooltipProvider>
          <PwaInstallProvider>
            <Routes>
              <Route path="/profile/:pubKey" element={<ProfilePage />} />
              <Route path="/s/:pubKey" element={<OldShareRedirect />} />
              <Route path="*" element={<AuthenticatedRoutes />} />
            </Routes>
          </PwaInstallProvider>
          <Toaster position="top-center" />
        </TooltipProvider>
      </BrowserRouter>
    </Suspense>
  );
}
```

要求：Provider 必须覆盖 public route 和 authenticated route，不能只挂在 `AuthenticatedRoutes` 里。

- [ ] **Step 4: 运行 `App` 测试，确认通过**

Run: `npx vitest run packages/web/test/pages/App.test.tsx --config packages/web/vite.config.ts`

Expected: PASS with route tests and provider placement tests green.

- [ ] **Step 5: 提交根层接线**

```bash
git add packages/web/src/App.tsx packages/web/test/pages/App.test.tsx
git commit -m "feat: wire PWA install provider at app root"
```

## Chunk 2: 文案基础、说明弹窗与 `【我】` 页面接入

### Task 4: 先补测试资源和运行时文案，再让页面测试可断言真实文本

**Files:**

- Modify: `packages/web/test/helpers/test-utils.tsx`
- Modify: `packages/web/public/locales/zh/translation.json`
- Modify: `packages/web/public/locales/en/translation.json`
- Modify: `packages/web/test/pages/MePage.test.tsx`

- [ ] **Step 1: 先写未知平台兜底的失败测试**

先在 `packages/web/test/pages/MePage.test.tsx` 顶部前置测试脚手架：

```tsx
import { beforeEach } from "vitest";
import { usePwaInstall } from "../../src/hooks/use-pwa-install";

vi.mock("../../src/hooks/use-pwa-install", () => ({
  usePwaInstall: vi.fn(),
}));

const mockedUsePwaInstall = vi.mocked(usePwaInstall);

function mockUsePwaInstall(overrides?: Partial<ReturnType<typeof usePwaInstall>>) {
  mockedUsePwaInstall.mockReturnValue({
    isPwaMode: false,
    platform: "desktop",
    isGuideOpen: false,
    shouldShowBrowserOpenHint: false,
    installOrShowGuide: vi.fn().mockResolvedValue(undefined),
    closeGuide: vi.fn(),
    ...overrides,
  } as ReturnType<typeof usePwaInstall>);
}

beforeEach(() => {
  mockedUsePwaInstall.mockReset();
});
```

在 `packages/web/test/pages/MePage.test.tsx` 中固定新增：

```tsx
it("shows unknown-platform fallback guidance", async () => {
  mockUsePwaInstall({
    isPwaMode: false,
    isGuideOpen: true,
    platform: "unknown",
    shouldShowBrowserOpenHint: true,
    installOrShowGuide: vi.fn(),
    closeGuide: vi.fn(),
  });

  renderMePage(vi.fn().mockResolvedValue({ data: createProfile() }));

  expect(
    await screen.findByText("如果没有看到相关选项，请改用 Safari 或 Chrome 打开当前页面后再试。"),
  ).toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试，确认先失败**

Run: `npx vitest run packages/web/test/pages/MePage.test.tsx --config packages/web/vite.config.ts`

Expected: FAIL，原因应指向缺少 `me.install` 测试资源或页面还未渲染说明弹窗。

- [ ] **Step 3: 在测试 i18n 资源中补最小安装文案**

向 `packages/web/test/helpers/test-utils.tsx` 的 `translation` 增加：

```ts
me: {
  install: {
    cta: "安装 PWA 应用",
    dialogTitle: "安装 ReMi",
    dialogDescription: "如果没有看到系统安装提示，可以按下面步骤手动安装。",
    close: "关闭",
    browserOpenHint: "如果当前页面来自内嵌浏览器，请改用 Safari 或 Chrome 打开后再安装。",
    fallbackHint: "如果没有看到相关选项，请改用 Safari 或 Chrome 打开当前页面后再试。",
    steps: {
      ios: ["在 Safari 中打开", "点击分享按钮", "选择添加到主屏幕"],
      android: ["打开浏览器菜单", "选择安装应用或添加到主屏幕"],
      desktop: ["查看地址栏中的安装图标", "或在浏览器菜单中选择安装应用"],
      unknown: [
        "请在浏览器菜单中查找安装应用或添加到主屏幕。",
        "如果没有看到相关选项，请改用 Safari 或 Chrome 打开当前页面后再试。",
      ],
    },
  },
},
```

- [ ] **Step 4: 在运行时中英文 locale 文件新增同结构 key**

要求：

- 同时新增 `me.install.close`
- 保留 `ios`、`android`、`desktop`、`unknown` 四组步骤
- 英文文案与中文结构完全一致
- 不新增未使用的 `title` / `description` 文案键

- [ ] **Step 5: 运行 `MePage` 测试，确认文案解析问题已消除**

Run: `npx vitest run packages/web/test/pages/MePage.test.tsx --config packages/web/vite.config.ts`

Expected: still FAIL，但失败原因应已收敛为“组件或页面接线尚未实现”，而不是翻译 key 缺失。

- [ ] **Step 6: 提交安装文案基础**

```bash
git add packages/web/test/helpers/test-utils.tsx \
  packages/web/public/locales/zh/translation.json \
  packages/web/public/locales/en/translation.json \
  packages/web/test/pages/MePage.test.tsx
git commit -m "feat: add PWA install copy"
```

### Task 5: 先写页面测试，再实现按钮与说明弹窗

**Files:**

- Create: `packages/web/src/components/pwa/PwaInstallDialog.tsx`
- Modify: `packages/web/src/pages/MePage.tsx`
- Modify: `packages/web/test/pages/MePage.test.tsx`

- [ ] **Step 1: 在 `MePage` 测试里补按钮显示、隐藏、点击和关闭行为**

沿用 Task 4 已加入的 `usePwaInstall` mock、`mockUsePwaInstall` helper 和 `beforeEach` reset，不再重复搭脚手架。

增加测试：

```tsx
import { userEvent } from "../helpers/test-utils";
import { fireEvent } from "../helpers/test-utils";

it("shows install CTA when running in the browser", async () => {
  mockUsePwaInstall({
    isPwaMode: false,
    isGuideOpen: false,
    platform: "desktop",
    shouldShowBrowserOpenHint: false,
    installOrShowGuide: vi.fn(),
    closeGuide: vi.fn(),
  });

  renderMePage(vi.fn().mockResolvedValue({ data: createProfile() }));

  expect(await screen.findByRole("button", { name: "安装 PWA 应用" })).toBeInTheDocument();
});

it("hides install CTA when already running as a PWA", async () => {
  mockUsePwaInstall({
    isPwaMode: true,
    isGuideOpen: false,
    platform: "desktop",
    shouldShowBrowserOpenHint: false,
    installOrShowGuide: vi.fn(),
    closeGuide: vi.fn(),
  });

  renderMePage(vi.fn().mockResolvedValue({ data: createProfile() }));

  await screen.findByText("mock-p...-key");
  expect(screen.queryByRole("button", { name: "安装 PWA 应用" })).not.toBeInTheDocument();
});

it("requests install when the CTA is tapped", async () => {
  const installOrShowGuide = vi.fn().mockResolvedValue(undefined);
  mockUsePwaInstall({
    isPwaMode: false,
    isGuideOpen: false,
    platform: "ios",
    shouldShowBrowserOpenHint: true,
    installOrShowGuide,
    closeGuide: vi.fn(),
  });

  renderMePage(vi.fn().mockResolvedValue({ data: createProfile() }));

  await userEvent.click(await screen.findByRole("button", { name: "安装 PWA 应用" }));

  expect(installOrShowGuide).toHaveBeenCalledTimes(1);
});

it("renders ios guidance and closes through the translated footer action", async () => {
  const closeGuide = vi.fn();
  mockUsePwaInstall({
    isPwaMode: false,
    isGuideOpen: true,
    platform: "ios",
    shouldShowBrowserOpenHint: true,
    installOrShowGuide: vi.fn(),
    closeGuide,
  });

  renderMePage(vi.fn().mockResolvedValue({ data: createProfile() }));

  expect(await screen.findByText("在 Safari 中打开")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "关闭" }));

  expect(closeGuide).toHaveBeenCalledTimes(1);
});

it("closes the install dialog when the dialog requests dismissal", async () => {
  const closeGuide = vi.fn();
  mockUsePwaInstall({
    isPwaMode: false,
    isGuideOpen: true,
    platform: "desktop",
    shouldShowBrowserOpenHint: false,
    installOrShowGuide: vi.fn(),
    closeGuide,
  });

  renderMePage(vi.fn().mockResolvedValue({ data: createProfile() }));

  expect(await screen.findByText("查看地址栏中的安装图标")).toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape" });

  expect(closeGuide).toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行 `MePage` 测试，确认先失败**

Run: `npx vitest run packages/web/test/pages/MePage.test.tsx --config packages/web/vite.config.ts`

Expected: FAIL，原因应指向按钮、弹窗、关闭动作或按钮接线尚未实现。

- [ ] **Step 3: 实现安装说明弹窗组件**

`packages/web/src/components/pwa/PwaInstallDialog.tsx` 目标结构：

```tsx
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { InstallPlatform } from "../../lib/pwa-install";

interface PwaInstallDialogProps {
  open: boolean;
  platform: InstallPlatform;
  shouldShowBrowserOpenHint: boolean;
  onClose: () => void;
}

export function PwaInstallDialog({
  open,
  platform,
  shouldShowBrowserOpenHint,
  onClose,
}: PwaInstallDialogProps) {
  const { t } = useTranslation();
  const steps = t(`me.install.steps.${platform}`, { returnObjects: true }) as string[];

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("me.install.dialogTitle")}</DialogTitle>
          <DialogDescription>{t("me.install.dialogDescription")}</DialogDescription>
        </DialogHeader>
        <ol className="list-decimal space-y-2 pl-5">
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {shouldShowBrowserOpenHint ? (
          <p className="text-sm text-muted-foreground">{t("me.install.browserOpenHint")}</p>
        ) : null}
        <p className="text-sm text-muted-foreground">{t("me.install.fallbackHint")}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("me.install.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

要求：

- `platform === "unknown"` 时读取 `me.install.steps.unknown`
- 禁用默认右上角关闭按钮，避免硬编码英文 `Close`
- 保留 `onOpenChange(false)` 触发的关闭路径

- [ ] **Step 4: 在 `MePage` 接入最小按钮入口与弹窗**

把 `packages/web/src/pages/MePage.tsx` 改成接入 `usePwaInstall()`，并在菜单区下方追加最小按钮区块：

```tsx
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePwaInstall } from "../hooks/use-pwa-install";
import { PwaInstallDialog } from "../components/pwa/PwaInstallDialog";

const {
  isPwaMode,
  platform,
  isGuideOpen,
  shouldShowBrowserOpenHint,
  installOrShowGuide,
  closeGuide,
} = usePwaInstall();

{
  !isPwaMode ? (
    <div className="pt-1">
      <Button className="w-full" onClick={() => void installOrShowGuide()}>
        <Download className="h-4 w-4" />
        {t("me.install.cta")}
      </Button>
    </div>
  ) : null;
}

<PwaInstallDialog
  open={isGuideOpen}
  platform={platform}
  shouldShowBrowserOpenHint={shouldShowBrowserOpenHint}
  onClose={closeGuide}
/>;
```

要求：

- 已安装时完全不渲染按钮区块
- 页面本身不写平台分支逻辑
- 不把 UI 扩展成新的说明卡片

- [ ] **Step 5: 运行 `MePage` 测试，确认通过**

Run: `npx vitest run packages/web/test/pages/MePage.test.tsx --config packages/web/vite.config.ts`

Expected: PASS with old profile tests still green and new install CTA tests green.

- [ ] **Step 6: 提交页面和弹窗 UI**

```bash
git add packages/web/src/components/pwa/PwaInstallDialog.tsx \
  packages/web/src/pages/MePage.tsx \
  packages/web/test/pages/MePage.test.tsx
git commit -m "feat: add PWA install CTA to me page"
```

## Chunk 3: 集成验证与回归

### Task 6: 运行完整验证并处理回归

**Files:**

- Verify: `packages/web/test/lib/pwa-install.test.ts`
- Verify: `packages/web/test/hooks/use-pwa-install.test.tsx`
- Verify: `packages/web/test/pages/MePage.test.tsx`
- Verify: `packages/web/test/pages/App.test.tsx`
- Verify: `packages/web/test/helpers/test-utils.tsx`
- Verify: `packages/web/src/pages/MePage.tsx`
- Verify: `packages/web/src/hooks/use-pwa-install.tsx`

- [ ] **Step 1: 运行本次新增的全部测试**

Run: `npx vitest run packages/web/test/lib/pwa-install.test.ts packages/web/test/hooks/use-pwa-install.test.tsx packages/web/test/pages/MePage.test.tsx packages/web/test/pages/App.test.tsx --config packages/web/vite.config.ts`

Expected: PASS with all targeted PWA install tests green.

这组自动化测试必须已经覆盖：

- `desktop` 平台读取桌面说明文案
- `unknown` 平台读取通用说明文案
- `prompt()` 抛错时回退到说明弹窗
- `userChoice.outcome === "dismissed"` 不算错误
- 一次性事件消费后再次点击会走回退路径，等待新事件
- 关闭按钮调用 `closeGuide`

- [ ] **Step 2: 运行相关页面回归测试**

Run: `npx vitest run packages/web/test/pages/SettingsPage.test.tsx packages/web/test/pages/SharePage.test.tsx packages/web/test/pages/ProfilePage.test.tsx --config packages/web/vite.config.ts`

Expected: PASS，确保 App 顶层新增 Provider 未破坏相邻页面。

- [ ] **Step 3: 运行 Web build**

Run: `npm run build --workspace @remi/web`

Expected: PASS，Vite build 成功，无类型错误。

- [ ] **Step 4: 手动验证安装入口行为**

Run: `npm run dev --workspace @remi/web`

Then verify manually:

- 普通浏览器打开 `/me` 时能看到 `安装 PWA 应用`
- DevTools 模拟或真实环境派发 `beforeinstallprompt` 时，点击按钮优先触发原生安装
- 没有安装事件时，点击按钮打开说明弹窗
- 模拟 `prompt()` 抛错或使用失效事件时，点击按钮回退到说明弹窗且无技术性报错
- iPhone/iPad 看到 Safari 安装说明
- Android 看到菜单安装说明
- 桌面浏览器看到地址栏图标或浏览器菜单说明
- 无法稳定识别平台时看到通用 fallback 说明，而不是被误归类到桌面或移动端
- 已安装后重新以 PWA 打开时，按钮消失

- [ ] **Step 5: 验证 locale 结构完整且文案未写死在组件里**

Run:

```bash
node - <<'EOF'
import fs from 'node:fs';

const files = [
  'packages/web/public/locales/zh/translation.json',
  'packages/web/public/locales/en/translation.json',
];

for (const file of files) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const install = data.me?.install;
  if (!install) throw new Error(`${file}: missing me.install`);
  for (const key of ['cta', 'dialogTitle', 'dialogDescription', 'close', 'browserOpenHint', 'fallbackHint']) {
    if (!install[key]) throw new Error(`${file}: missing ${key}`);
  }
  for (const key of ['ios', 'android', 'desktop', 'unknown']) {
    if (!Array.isArray(install.steps?.[key]) || install.steps[key].length === 0) {
      throw new Error(`${file}: missing install.steps.${key}`);
    }
  }
}
EOF
```

Then run: `npx vitest run packages/web/test/pages/MePage.test.tsx packages/web/test/hooks/use-pwa-install.test.tsx --config packages/web/vite.config.ts`

Expected: locale script exits 0, and tests PASS with assertions reading translated text rather than raw i18n keys.

- [ ] **Step 6: 提交完整实现或确认工作区干净**

如果前面未分段提交：

```bash
git add packages/web/src/App.tsx \
  packages/web/src/components/pwa/PwaInstallDialog.tsx \
  packages/web/src/hooks/use-pwa-install.tsx \
  packages/web/src/lib/pwa-install.ts \
  packages/web/src/types/pwa-install.d.ts \
  packages/web/src/pages/MePage.tsx \
  packages/web/public/locales/zh/translation.json \
  packages/web/public/locales/en/translation.json \
  packages/web/test/helpers/test-utils.tsx \
  packages/web/test/lib/pwa-install.test.ts \
  packages/web/test/hooks/use-pwa-install.test.tsx \
  packages/web/test/pages/MePage.test.tsx \
  packages/web/test/pages/App.test.tsx
git commit -m "feat: add guided PWA install flow"
```

如果前面已经按 task 分段提交：

Run: `git status --short`

Expected: no output.
