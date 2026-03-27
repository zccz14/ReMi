import { type ReactElement } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import i18n from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { AuthContext } from "../../src/hooks/use-auth";
import type { ApiClient } from "../../src/lib/api-client";
import type { KeyStore } from "@remi/client";

// ---------- i18n test instance ----------

const testI18n = i18n.createInstance();
testI18n.use(initReactI18next).init({
  lng: "zh",
  resources: {
    en: {
      translation: {
        common: {
          ephemeralWarning: "Using temporary identity. Data will be lost when browser closes.",
        },
        me: {
          title: "Me",
          stats: "Stats",
          anchors: "Soul Anchors",
          share: "Share Card",
          settings: "Settings",
          install: {
            cta: "Install app",
            dialogTitle: "Install ReMi",
            dialogDescription: "Save ReMi to your device for faster access.",
            close: "Close",
            browserOpenHint:
              "If this page is open inside another app, open it in your browser first.",
            fallbackHint:
              "If you do not see an install option, you can keep using ReMi in your browser.",
            steps: {
              ios: ["Tap the Share button in Safari.", "Choose Add to Home Screen, then confirm."],
              android: [
                "Open the browser menu.",
                "Tap Install app or Add to Home screen, then confirm.",
              ],
              desktop: [
                "Click the install icon in the address bar.",
                "Confirm the install prompt to add ReMi.",
              ],
              unknown: [
                "Open your browser menu and look for Install app or Add to Home screen.",
                "If no install option appears, keep using ReMi in your browser.",
              ],
            },
          },
        },
      },
    },
    zh: {
      translation: {
        common: { ephemeralWarning: "临时身份警告" },
        me: {
          title: "我",
          stats: "数据统计",
          anchors: "灵魂锚点",
          share: "分享名片",
          settings: "设置",
          install: {
            cta: "安装应用",
            dialogTitle: "安装 ReMi",
            dialogDescription: "将 ReMi 添加到你的设备，获得更便捷的访问体验。",
            close: "关闭",
            browserOpenHint: "如果当前页面是在其他应用里打开，请先在浏览器中打开。",
            fallbackHint: "如果没有看到安装选项，也可以继续在浏览器中使用 ReMi。",
            steps: {
              ios: ["在 Safari 中点击分享按钮。", "选择“添加到主屏幕”，然后确认。"],
              android: ["打开浏览器菜单。", "点击“安装应用”或“添加到主屏幕”，然后确认。"],
              desktop: ["点击地址栏中的安装图标。", "在安装提示中确认，将 ReMi 添加到设备。"],
              unknown: [
                "打开浏览器菜单，查找“安装应用”或“添加到主屏幕”。",
                "如果没有出现安装选项，也可以继续在浏览器中使用 ReMi。",
              ],
            },
          },
        },
      },
    },
  },
  interpolation: { escapeValue: false },
});

// ---------- Auth mock factory ----------

interface AuthState {
  initialized: boolean;
  publicKey: string;
  isEphemeral: boolean;
  apiClient: ApiClient;
  keyStore: KeyStore;
}

export function createMockAuthState(overrides?: Partial<AuthState>): AuthState {
  return {
    initialized: true,
    publicKey: "mock-public-key",
    isEphemeral: false,
    apiClient: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      del: vi.fn(),
      streamPost: vi.fn(),
      ownerPath: vi.fn((p: string) => `/api/mock-public-key${p}`),
    } as unknown as ApiClient,
    keyStore: {
      getPublicKey: vi.fn(() => "mock-public-key"),
      sign: vi.fn(async () => "mock-signature"),
      isEphemeral: vi.fn(() => false),
      exportPrivateKey: vi.fn(() => "mock-private-key"),
      importPrivateKey: vi.fn(async () => {}),
      init: vi.fn(async () => {}),
    } as unknown as KeyStore,
    ...overrides,
  };
}

// ---------- renderWithProviders ----------

interface CustomRenderOptions extends Omit<RenderOptions, "wrapper"> {
  route?: string;
  authState?: Partial<AuthState>;
}

export function renderWithProviders(ui: ReactElement, options: CustomRenderOptions = {}) {
  const { route = "/", authState, ...renderOptions } = options;
  const mergedAuthState = createMockAuthState(authState);

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <I18nextProvider i18n={testI18n}>
        <MemoryRouter initialEntries={[route]}>
          <AuthContext.Provider value={mergedAuthState}>{children}</AuthContext.Provider>
        </MemoryRouter>
      </I18nextProvider>
    );
  }

  return {
    ...render(ui, { wrapper: Wrapper, ...renderOptions }),
    authState: mergedAuthState,
  };
}

// ---------- Re-exports ----------

export * from "@testing-library/react";
export { default as userEvent } from "@testing-library/user-event";
