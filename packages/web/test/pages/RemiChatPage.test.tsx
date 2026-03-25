import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, createMockAuthState, renderWithProviders, screen, waitFor } from "../helpers/test-utils";
import { RemiChatPage } from "../../src/pages/RemiChatPage";

const API_BASE = "https://api.example.test";

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
    displayName: "",
    bio: "",
    hasAvatar: false,
    avatarVersion: null,
    updatedAt: 1710000000000,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("RemiChatPage", () => {
  it("uses owner profile data for the current user's message avatar", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    vi.stubEnv("VITE_API_BASE", API_BASE);

    const authState = createMockAuthState({
      apiClient: {
        get: vi.fn((path: string) => {
          if (path === "/api/mock-public-key/profile") {
            return Promise.resolve({
              data: createProfile({ displayName: "Owner", hasAvatar: true, avatarVersion: 5 }),
            });
          }

          if (path.startsWith("/api/mock-public-key/interview/messages")) {
            return Promise.resolve({
              data: {
                items: [{ id: 1, role: "user", content: "hello remi", created_at: 1 }],
                hasMore: false,
              },
            });
          }

          throw new Error(`unexpected path: ${path}`);
        }),
        post: vi.fn(),
        put: vi.fn(),
        del: vi.fn(),
        streamPost: vi.fn(),
        ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
      } as any,
    });

    renderWithProviders(<RemiChatPage />, { authState });

    expect(await screen.findByText("hello remi")).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Owner" })).toHaveAttribute(
      "src",
      `${API_BASE}/api/public/mock-public-key/profile/avatar?v=5`,
    );
  });

  it("falls back to a generated current-user avatar when the owner has no public avatar", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    const authState = createMockAuthState({
      apiClient: {
        get: vi.fn((path: string) => {
          if (path === "/api/mock-public-key/profile") {
            return Promise.resolve({ data: createProfile({ displayName: "Owner" }) });
          }

          if (path.startsWith("/api/mock-public-key/interview/messages")) {
            return Promise.resolve({
              data: {
                items: [{ id: 1, role: "user", content: "hello remi", created_at: 1 }],
                hasMore: false,
              },
            });
          }

          throw new Error(`unexpected path: ${path}`);
        }),
        post: vi.fn(),
        put: vi.fn(),
        del: vi.fn(),
        streamPost: vi.fn(),
        ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
      } as any,
    });

    renderWithProviders(<RemiChatPage />, { authState });

    expect(await screen.findByText("hello remi")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("img", { name: "Owner" })).not.toBeInTheDocument();
    });
    expect(screen.getAllByText("O").length).toBeGreaterThan(0);
  });
});
