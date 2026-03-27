import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const testHelpersDir = path.dirname(fileURLToPath(import.meta.url));

function readTestLocale(locale: "en" | "zh") {
  return JSON.parse(
    fs.readFileSync(
      path.resolve(testHelpersDir, "../../public/locales", locale, "translation.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

const testI18n = i18n.createInstance();
testI18n.use(initReactI18next).init({
  lng: "zh",
  resources: {
    en: {
      translation: readTestLocale("en"),
    },
    zh: {
      translation: readTestLocale("zh"),
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
