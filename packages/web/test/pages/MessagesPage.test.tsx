import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderWithProviders, screen } from "../helpers/test-utils";
import { MessagesPage } from "../../src/pages/MessagesPage";
import { clearPublicProfileCache, emptyPublicProfile } from "../../src/lib/profile";

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

function renderMessagesPage(conversations: Array<Record<string, unknown>>) {
  return renderWithProviders(<MessagesPage />, {
    authState: {
      apiClient: {
        get: vi.fn().mockResolvedValue({ data: conversations }),
        post: vi.fn(),
        put: vi.fn(),
        del: vi.fn(),
        streamPost: vi.fn(),
        ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
      } as any,
    },
  });
}

function mockProfiles(profiles: Record<string, ReturnType<typeof createProfile>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request) => {
      const url = String(input);
      const match = url.match(/\/api\/public\/(.+)\/profile$/);
      const pubKey = match?.[1];
      if (!pubKey || !profiles[pubKey]) {
        throw new Error(`unexpected profile fetch: ${url}`);
      }

      return Promise.resolve({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: profiles[pubKey] }),
      });
    }),
  );
}

afterEach(() => {
  cleanup();
  clearPublicProfileCache();
  vi.restoreAllMocks();
});

describe("MessagesPage", () => {
  it("shows public nickname for avatar conversations", async () => {
    mockProfiles({
      abcdef1234567890: createProfile({ displayName: "Nova" }),
    });

    renderMessagesPage([
      { type: "avatar", pubKey: "abcdef1234567890", lastMessage: "hi", lastMessageAt: 1 },
    ]);

    expect(await screen.findByText("Nova")).toBeInTheDocument();
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
  });

  it("keeps the ReMi conversation name unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn());

    renderMessagesPage([{ type: "remi", lastMessage: "hello", lastMessageAt: 1 }]);

    expect(await screen.findByText("ReMi")).toBeInTheDocument();
  });
});
