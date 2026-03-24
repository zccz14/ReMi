import { afterEach, describe, expect, it, vi } from "vitest";
import { Link, Route, Routes } from "react-router-dom";
import { cleanup, renderWithProviders, screen, userEvent, waitFor } from "../helpers/test-utils";
import { AvatarChatPage } from "../../src/pages/AvatarChatPage";
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

function mockPublicProfileFetch(
  profile: ReturnType<typeof createProfile> = createProfile({ displayName: "Nova" }),
) {
  vi.stubEnv("VITE_API_BASE", API_BASE);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: profile }),
    }),
  );
}

function mockPublicProfileFailure() {
  vi.stubEnv("VITE_API_BASE", API_BASE);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
}

function renderAvatarChatPage(route = "/chat/abcdef1234567890") {
  return renderWithProviders(
    <Routes>
      <Route path="/chat/:pubKey" element={<AvatarChatPage />} />
      <Route path="/profile/:pubKey" element={<div>profile-route</div>} />
    </Routes>,
    {
      route,
      authState: {
        apiClient: {
          get: vi.fn().mockResolvedValue({ data: { items: [], hasMore: false } }),
          post: vi.fn(),
          put: vi.fn(),
          del: vi.fn(),
          streamPost: vi.fn(),
          ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
        } as any,
      },
    },
  );
}

function deferredProfileResponse(profile: ReturnType<typeof createProfile>) {
  let resolve!: (value: {
    ok: boolean;
    json: () => Promise<{ data: ReturnType<typeof createProfile> }>;
  }) => void;

  const promise = new Promise<{
    ok: boolean;
    json: () => Promise<{ data: ReturnType<typeof createProfile> }>;
  }>((res) => {
    resolve = res;
  });

  return {
    promise,
    resolve: () =>
      resolve({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: profile }),
      }),
  };
}

afterEach(() => {
  cleanup();
  clearPublicProfileCache();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("AvatarChatPage", () => {
  it("shows public nickname and avatar in the chat header", async () => {
    mockPublicProfileFetch(
      createProfile({ displayName: "Nova", hasAvatar: true, avatarVersion: 3 }),
    );

    renderAvatarChatPage();

    expect(await screen.findByText("Nova")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Nova" })).toHaveAttribute(
      "src",
      `${API_BASE}/api/public/abcdef1234567890/profile/avatar?v=3`,
    );
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
  });

  it("falls back to truncated pubKey and generated avatar when profile load fails", async () => {
    mockPublicProfileFailure();

    renderAvatarChatPage();

    expect(await screen.findByText("abcdef...7890")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("keeps avatar click navigation to /profile/:pubKey", async () => {
    mockPublicProfileFetch();

    renderAvatarChatPage();

    await userEvent.setup().click(await screen.findByRole("button", { name: "Nova" }));

    expect(await screen.findByText("profile-route")).toBeInTheDocument();
  });

  it("reloads the chat when the route pubKey changes on the same mounted page", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    vi.stubEnv("VITE_API_BASE", API_BASE);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("firstpub1234567890")) {
          return Promise.resolve({
            ok: true,
            json: vi.fn().mockResolvedValue({ data: createProfile({ displayName: "First" }) }),
          });
        }

        if (url.includes("secondpub1234567890")) {
          return Promise.resolve({
            ok: true,
            json: vi.fn().mockResolvedValue({ data: createProfile({ displayName: "Second" }) }),
          });
        }

        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const get = vi.fn((path: string) => {
      if (path.includes("firstpub1234567890")) {
        return Promise.resolve({
          data: {
            items: [{ id: 1, role: "assistant", content: "first conversation", created_at: 1 }],
            hasMore: false,
          },
        });
      }

      if (path.includes("secondpub1234567890")) {
        return Promise.resolve({
          data: {
            items: [{ id: 2, role: "assistant", content: "second conversation", created_at: 2 }],
            hasMore: false,
          },
        });
      }

      throw new Error(`unexpected path: ${path}`);
    });

    renderWithProviders(
      <Routes>
        <Route
          path="/chat/:pubKey"
          element={
            <>
              <Link to="/chat/secondpub1234567890">go-second-chat</Link>
              <AvatarChatPage />
            </>
          }
        />
        <Route path="/profile/:pubKey" element={<div>profile-route</div>} />
      </Routes>,
      {
        route: "/chat/firstpub1234567890",
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
      },
    );

    expect(await screen.findByText("first conversation")).toBeInTheDocument();

    await userEvent.setup().click(screen.getByText("go-second-chat"));

    expect(await screen.findByText("second conversation")).toBeInTheDocument();
    expect(screen.queryByText("first conversation")).not.toBeInTheDocument();
  });

  it("resets header identity immediately when the route pubKey changes", async () => {
    const secondProfile = deferredProfileResponse(createProfile({ displayName: "Second" }));

    vi.stubEnv("VITE_API_BASE", API_BASE);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("firstpub1234567890")) {
          return Promise.resolve({
            ok: true,
            json: vi.fn().mockResolvedValue({
              data: createProfile({ displayName: "First", hasAvatar: true, avatarVersion: 1 }),
            }),
          });
        }

        if (url.includes("secondpub1234567890")) {
          return secondProfile.promise;
        }

        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    renderWithProviders(
      <Routes>
        <Route
          path="/chat/:pubKey"
          element={
            <>
              <Link to="/chat/secondpub1234567890">go-second-chat</Link>
              <AvatarChatPage />
            </>
          }
        />
      </Routes>,
      {
        route: "/chat/firstpub1234567890",
        authState: {
          apiClient: {
            get: vi.fn().mockResolvedValue({ data: { items: [], hasMore: false } }),
            post: vi.fn(),
            put: vi.fn(),
            del: vi.fn(),
            streamPost: vi.fn(),
            ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
          } as any,
        },
      },
    );

    expect(await screen.findByText("First")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "First" })).toHaveAttribute(
      "src",
      `${API_BASE}/api/public/firstpub1234567890/profile/avatar?v=1`,
    );

    await userEvent.setup().click(screen.getByText("go-second-chat"));

    expect(screen.queryByText("First")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "First" })).not.toBeInTheDocument();
    expect(screen.getByText("second...7890")).toBeInTheDocument();

    secondProfile.resolve();

    expect(await screen.findByText("Second")).toBeInTheDocument();
  });
});
