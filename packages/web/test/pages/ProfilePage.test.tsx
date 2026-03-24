import { afterEach, describe, expect, it, vi } from "vitest";
import { Link, Route, Routes } from "react-router-dom";
import {
  cleanup,
  fireEvent,
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
} from "../helpers/test-utils";
import { ProfilePage } from "../../src/pages/ProfilePage";

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

function renderProfilePage(route = "/profile/abcdef1234567890") {
  return renderWithProviders(
    <Routes>
      <Route path="/profile/:pubKey" element={<ProfilePage />} />
    </Routes>,
    { route },
  );
}

function deferredResponse() {
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

  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("ProfilePage", () => {
  it("renders public nickname and bio from the public profile API", async () => {
    vi.stubEnv("VITE_API_BASE", API_BASE);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: createProfile({
            displayName: "Z",
            bio: "hello",
            hasAvatar: true,
            avatarVersion: 7,
          }),
        }),
      }),
    );

    renderProfilePage();

    expect(await screen.findByText("Z")).toBeInTheDocument();
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByAltText("Z")).toHaveAttribute(
      "src",
      `${API_BASE}/api/public/abcdef1234567890/profile/avatar?v=7`,
    );
    expect(screen.getByRole("button", { name: "profile.sendMessage" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(`${API_BASE}/api/public/abcdef1234567890/profile`);
  });

  it("falls back to ChatAvatar when the avatar image fails to load", async () => {
    vi.stubEnv("VITE_API_BASE", API_BASE);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: createProfile({
            displayName: "Nova",
            hasAvatar: true,
            avatarVersion: 3,
          }),
        }),
      }),
    );

    const { container } = renderProfilePage();

    const avatarImage = await screen.findByAltText("Nova");
    fireEvent.error(avatarImage);

    await waitFor(() => {
      expect(container.querySelector("img")).toBeNull();
    });
    expect(screen.getByText("N")).toBeInTheDocument();
  });

  it("falls back to truncated pubkey and ChatAvatar when profile is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: createProfile(),
        }),
      }),
    );

    const { container } = renderProfilePage();

    expect(await screen.findByRole("button", { name: "profile.sendMessage" })).toBeInTheDocument();
    expect(screen.queryAllByText("abcdef...7890").length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("keeps the truncated public key visible as supporting identity text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: createProfile({
            displayName: "Display Name",
          }),
        }),
      }),
    );

    renderProfilePage();

    expect(await screen.findByText("Display Name")).toBeInTheDocument();
    expect(screen.getByText("abcdef...7890")).toBeInTheDocument();
  });

  it("clears the previous profile while a new pubKey fetch is pending", async () => {
    const firstPubKey = "abcdef1234567890";
    const secondPubKey = "bcdefg1234567890";
    const firstResponse = deferredResponse();
    const secondResponse = deferredResponse();

    vi.stubEnv("VITE_API_BASE", API_BASE);

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | globalThis.Request) => {
        const url = String(input);
        if (url.includes(firstPubKey)) {
          return firstResponse.promise;
        }
        if (url.includes(secondPubKey)) {
          return secondResponse.promise;
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    renderWithProviders(
      <Routes>
        <Route
          path="/profile/:pubKey"
          element={
            <>
              <Link to={`/profile/${secondPubKey}`}>go-second-profile</Link>
              <ProfilePage />
            </>
          }
        />
      </Routes>,
      { route: `/profile/${firstPubKey}` },
    );

    firstResponse.resolve({
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: createProfile({
          displayName: "First Name",
          bio: "first bio",
          hasAvatar: true,
          avatarVersion: 1,
        }),
      }),
    });

    expect(await screen.findByText("First Name")).toBeInTheDocument();
    expect(screen.getByText("first bio")).toBeInTheDocument();
    expect(screen.getByAltText("First Name")).toHaveAttribute(
      "src",
      `${API_BASE}/api/public/${firstPubKey}/profile/avatar?v=1`,
    );

    await userEvent.setup().click(screen.getByText("go-second-profile"));

    await waitFor(() => {
      expect(screen.queryByText("First Name")).not.toBeInTheDocument();
    });
    expect(screen.queryByText("first bio")).not.toBeInTheDocument();
    expect(screen.queryByAltText("First Name")).not.toBeInTheDocument();
    expect(screen.getByText("bcdefg...7890")).toBeInTheDocument();
  });

  it("shows a not found state instead of a fallback profile when the public profile is missing", async () => {
    vi.stubEnv("VITE_API_BASE", API_BASE);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }),
    );

    renderProfilePage();

    expect(await screen.findByText("profile.notFound")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "profile.sendMessage" })).not.toBeInTheDocument();
    expect(screen.queryByText("A")).not.toBeInTheDocument();
  });

  it("shows an invalid-link state when the public profile url is invalid", async () => {
    vi.stubEnv("VITE_API_BASE", API_BASE);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
      }),
    );

    renderProfilePage();

    expect(await screen.findByText("profile.invalidLink")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "profile.sendMessage" })).not.toBeInTheDocument();
    expect(screen.queryByText("A")).not.toBeInTheDocument();
  });

  it("shows an error state instead of a fallback profile when the fetch fails", async () => {
    vi.stubEnv("VITE_API_BASE", API_BASE);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network failed")));

    renderProfilePage();

    expect(await screen.findByText("profile.error")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "profile.sendMessage" })).not.toBeInTheDocument();
    expect(screen.queryByText("A")).not.toBeInTheDocument();
  });
});
