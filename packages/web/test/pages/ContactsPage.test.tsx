import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderWithProviders, screen } from "../helpers/test-utils";
import { ContactsPage } from "../../src/pages/ContactsPage";
import { clearPublicProfileCache, emptyPublicProfile } from "../../src/lib/profile";

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
    ...emptyPublicProfile,
    updatedAt: 1710000000000,
    ...overrides,
  };
}

function renderContactsPage(
  contacts = [{ pubKey: "b-key-1234567890" }, { pubKey: "a-key-1234567890" }],
) {
  const get = vi.fn().mockResolvedValue({ data: contacts });

  return renderWithProviders(<ContactsPage />, {
    authState: {
      apiClient: {
        get,
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
  vi.stubEnv("VITE_API_BASE", API_BASE);
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
  vi.unstubAllEnvs();
});

describe("ContactsPage", () => {
  it("shows resolved nickname and avatar for each contact", async () => {
    mockProfiles({
      "b-key-1234567890": createProfile({ displayName: "Nova" }),
      "a-key-1234567890": createProfile({ displayName: "Ada", hasAvatar: true, avatarVersion: 1 }),
    });

    renderContactsPage();

    expect(await screen.findByText("Nova")).toBeInTheDocument();
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Ada" })).toHaveAttribute(
      "src",
      `${API_BASE}/api/public/a-key-1234567890/profile/avatar?v=1`,
    );
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
  });

  it("preserves the existing raw-pubKey grouping order while rows are enriched", async () => {
    mockProfiles({
      "b-key-1234567890": createProfile({ displayName: "Nova" }),
      "a-key-1234567890": createProfile({ displayName: "Ada" }),
    });

    renderContactsPage();

    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(await screen.findByText("Nova")).toBeInTheDocument();
    const rows = await screen.findAllByRole("button");
    expect(rows[0]).toHaveTextContent("Ada");
    expect(rows[1]).toHaveTextContent("Nova");
  });
});
