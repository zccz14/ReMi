import { describe, it, expect, afterEach, vi } from "vitest";
import { toast } from "sonner";
import { renderWithProviders, cleanup, userEvent, waitFor } from "../helpers/test-utils";
import { SettingsPage } from "../../src/pages/SettingsPage";
import type { ApiClient } from "../../src/lib/api-client";

let avatarConfirmResult: unknown = null;

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../src/components/profile/AvatarCropDialog", () => ({
  AvatarCropDialog: ({
    open,
    file,
    onConfirm,
    onCancel,
  }: {
    open: boolean;
    file: File | null;
    onConfirm: (blob: Blob) => void | Promise<void>;
    onCancel: () => void;
  }) =>
    open ? (
      <div>
        <span>{file?.name}</span>
        <button
          onClick={() => {
            avatarConfirmResult = onConfirm(new Blob(["avatar"], { type: "image/webp" }));
          }}
        >
          confirm-avatar-crop
        </button>
        <button onClick={onCancel}>cancel-avatar-crop</button>
      </div>
    ) : null,
}));

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
  vi.clearAllMocks();
  avatarConfirmResult = null;
});

describe("SettingsPage", () => {
  it("displays the public key", () => {
    const { getByText } = renderWithProviders(<SettingsPage />);
    expect(getByText("mock-public-key")).toBeInTheDocument();
  });

  it("clicking export toggles private key visibility", async () => {
    const { getByText, queryByText } = renderWithProviders(<SettingsPage />);

    // Private key should not be visible initially
    expect(queryByText("mock-private-key")).not.toBeInTheDocument();

    const user = userEvent.setup();
    const exportButton = getByText("settings.exportKey");
    await user.click(exportButton);

    // Private key should now be visible
    expect(getByText("mock-private-key")).toBeInTheDocument();

    // Click again to hide
    await user.click(exportButton);
    expect(queryByText("mock-private-key")).not.toBeInTheDocument();
  });

  it("shows import input field", () => {
    const { getByPlaceholderText } = renderWithProviders(<SettingsPage />);
    expect(getByPlaceholderText("settings.importPlaceholder")).toBeInTheDocument();
  });

  it("loads owner profile data into the public profile form", async () => {
    const mockGet = vi.fn().mockResolvedValue({
      data: createProfile({ displayName: "Z", bio: "hello", hasAvatar: true, avatarVersion: 1 }),
    });

    const { findByDisplayValue } = renderWithProviders(<SettingsPage />, {
      authState: {
        apiClient: {
          get: mockGet,
          post: vi.fn(),
          put: vi.fn(),
          putBinary: vi.fn(),
          del: vi.fn(),
          streamPost: vi.fn(),
          ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
        } as unknown as ApiClient,
      },
    });

    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("/api/mock-public-key/profile");
    });
    expect(await findByDisplayValue("Z")).toBeInTheDocument();
    expect(await findByDisplayValue("hello")).toBeInTheDocument();
  });

  it("blocks saving when the initial owner profile load fails", async () => {
    const mockPut = vi.fn();

    const { findByRole } = renderWithProviders(<SettingsPage />, {
      authState: {
        apiClient: {
          get: vi.fn().mockRejectedValue(new Error("load failed")),
          post: vi.fn(),
          put: mockPut,
          putBinary: vi.fn(),
          del: vi.fn(),
          streamPost: vi.fn(),
          ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
        } as unknown as ApiClient,
      },
    });

    const saveButton = await findByRole("button", { name: "settings.saveProfile" });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("settings.profileLoadError");
    });
    expect(saveButton).toBeDisabled();
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("allows retrying profile bootstrap after an initial load failure", async () => {
    let profileCalls = 0;
    const mockGet = vi.fn((path: string) => {
      if (path === "/api/mock-public-key/api-tokens") {
        return Promise.resolve({ items: [] });
      }

      if (path === "/api/mock-public-key/profile") {
        profileCalls += 1;

        if (profileCalls === 1) {
          return Promise.reject(new Error("load failed"));
        }

        return Promise.resolve({
          data: createProfile({ displayName: "Recovered", bio: "hello" }),
        });
      }

      return Promise.reject(new Error(`unexpected path: ${path}`));
    });

    const { findByRole, findByDisplayValue, queryByRole } = renderWithProviders(<SettingsPage />, {
      authState: {
        apiClient: {
          get: mockGet,
          post: vi.fn(),
          put: vi.fn(),
          putBinary: vi.fn(),
          del: vi.fn(),
          streamPost: vi.fn(),
          ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
        } as unknown as ApiClient,
      },
    });

    const retryButton = await findByRole("button", { name: "settings.retryProfileLoad" });
    expect(retryButton).toBeEnabled();

    const user = userEvent.setup();
    await user.click(retryButton);

    expect(await findByDisplayValue("Recovered")).toBeInTheDocument();
    expect(await findByDisplayValue("hello")).toBeInTheDocument();
    await waitFor(() => {
      expect(queryByRole("button", { name: "settings.retryProfileLoad" })).not.toBeInTheDocument();
    });
  });

  it("keeps the public profile form disabled until the first bootstrap succeeds", async () => {
    const mockGet = vi.fn(() => new Promise(() => {}));

    const { getByLabelText, getByRole } = renderWithProviders(<SettingsPage />, {
      authState: {
        apiClient: {
          get: mockGet,
          post: vi.fn(),
          put: vi.fn(),
          putBinary: vi.fn(),
          del: vi.fn(),
          streamPost: vi.fn(),
          ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
        } as unknown as ApiClient,
      },
    });

    expect(getByLabelText("settings.displayName")).toBeDisabled();
    expect(getByLabelText("settings.bio")).toBeDisabled();
    expect(getByLabelText("settings.uploadAvatar")).toBeDisabled();
    expect(getByRole("button", { name: "settings.saveProfile" })).toBeDisabled();
  });

  it("saves edited displayName and bio through PUT /api/:pubKey/profile", async () => {
    const mockGet = vi.fn().mockResolvedValue({ data: createProfile() });
    const mockPut = vi.fn().mockResolvedValue({
      data: createProfile({ displayName: "Zed", bio: "hello world" }),
    });

    const { getByLabelText, getByRole } = renderWithProviders(<SettingsPage />, {
      authState: {
        apiClient: {
          get: mockGet,
          post: vi.fn(),
          put: mockPut,
          putBinary: vi.fn(),
          del: vi.fn(),
          streamPost: vi.fn(),
          ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
        } as unknown as ApiClient,
      },
    });

    await waitFor(() => {
      expect(getByLabelText("settings.displayName")).toBeEnabled();
      expect(getByLabelText("settings.bio")).toBeEnabled();
    });

    const user = userEvent.setup();
    await user.type(await getByLabelText("settings.displayName"), "Zed");
    await user.type(getByLabelText("settings.bio"), "hello world");
    await user.click(getByRole("button", { name: "settings.saveProfile" }));

    expect(mockPut).toHaveBeenCalledWith("/api/mock-public-key/profile", {
      displayName: "Zed",
      bio: "hello world",
    });
    expect(toast.success).toHaveBeenCalledWith("settings.profileSaved");
  });

  it("rejects gif selection before crop/upload", async () => {
    const mockPutBinary = vi.fn();
    const { getByLabelText, queryByText } = renderWithProviders(<SettingsPage />, {
      authState: {
        apiClient: {
          get: vi.fn().mockResolvedValue({ data: createProfile() }),
          post: vi.fn(),
          put: vi.fn(),
          putBinary: mockPutBinary,
          del: vi.fn(),
          streamPost: vi.fn(),
          ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
        } as unknown as ApiClient,
      },
    });

    await waitFor(() => {
      expect(getByLabelText("settings.uploadAvatar")).toBeEnabled();
    });

    const user = userEvent.setup({ applyAccept: false });
    const input = getByLabelText("settings.uploadAvatar") as HTMLInputElement;
    expect(input).toHaveAttribute("accept", "image/png,image/jpeg,image/webp");
    await user.upload(input, new File(["gif"], "avatar.gif", { type: "image/gif" }));

    expect(toast.error).toHaveBeenCalledWith("settings.avatarGifUnsupported");
    expect(mockPutBinary).not.toHaveBeenCalled();
    expect(queryByText("confirm-avatar-crop")).not.toBeInTheDocument();
  });

  it("blocks avatar mutations until the first bootstrap succeeds", async () => {
    const mockPutBinary = vi.fn();
    const mockDelete = vi.fn();

    const { getByLabelText, queryByRole } = renderWithProviders(<SettingsPage />, {
      authState: {
        apiClient: {
          get: vi.fn(() => new Promise(() => {})),
          post: vi.fn(),
          put: vi.fn(),
          putBinary: mockPutBinary,
          del: mockDelete,
          streamPost: vi.fn(),
          ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
        } as unknown as ApiClient,
      },
    });

    expect(getByLabelText("settings.uploadAvatar")).toBeDisabled();
    expect(queryByRole("button", { name: "settings.deleteAvatar" })).not.toBeInTheDocument();
    expect(mockPutBinary).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("uploads a cropped avatar and refreshes preview version", async () => {
    let profileCalls = 0;
    const mockGet = vi.fn((path: string) => {
      if (path === "/api/mock-public-key/api-tokens") {
        return Promise.resolve({ items: [] });
      }

      if (path === "/api/mock-public-key/profile") {
        profileCalls += 1;
        return Promise.resolve({
          data: createProfile({
            displayName: "Z",
            bio: "hello",
            hasAvatar: true,
            avatarVersion: profileCalls === 1 ? 1 : 2,
          }),
        });
      }

      return Promise.reject(new Error(`unexpected path: ${path}`));
    });
    const mockPutBinary = vi.fn().mockResolvedValue(undefined);

    const { getByLabelText, getByRole, findByAltText } = renderWithProviders(<SettingsPage />, {
      authState: {
        apiClient: {
          get: mockGet,
          post: vi.fn(),
          put: vi.fn(),
          putBinary: mockPutBinary,
          del: vi.fn(),
          streamPost: vi.fn(),
          ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
        } as unknown as ApiClient,
      },
    });

    expect(await findByAltText("settings.avatarPreview")).toHaveAttribute(
      "src",
      `${window.location.origin}/api/public/mock-public-key/profile/avatar?v=1`,
    );

    const user = userEvent.setup();
    await user.upload(
      getByLabelText("settings.uploadAvatar"),
      new File(["png"], "avatar.png", { type: "image/png" }),
    );
    await user.click(getByRole("button", { name: "confirm-avatar-crop" }));

    expect(avatarConfirmResult).toBeInstanceOf(Promise);

    await waitFor(() => {
      expect(mockPutBinary).toHaveBeenCalledWith(
        "/api/mock-public-key/profile/avatar",
        expect.any(Blob),
        "image/webp",
      );
    });

    expect(await findByAltText("settings.avatarPreview")).toHaveAttribute(
      "src",
      `${window.location.origin}/api/public/mock-public-key/profile/avatar?v=2`,
    );
    expect(toast.success).toHaveBeenCalledWith("settings.avatarUploadSuccess");
  });

  it("does not show avatar upload success if the refresh fails", async () => {
    const mockGet = vi
      .fn()
      .mockResolvedValueOnce({
        data: createProfile({ displayName: "Z", bio: "hello", hasAvatar: true, avatarVersion: 1 }),
      })
      .mockRejectedValueOnce(new Error("refresh failed"));
    const mockPutBinary = vi.fn().mockResolvedValue(undefined);

    const { getByLabelText, getByRole, findByAltText, queryByText } = renderWithProviders(
      <SettingsPage />,
      {
        authState: {
          apiClient: {
            get: mockGet,
            post: vi.fn(),
            put: vi.fn(),
            putBinary: mockPutBinary,
            del: vi.fn(),
            streamPost: vi.fn(),
            ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
          } as unknown as ApiClient,
        },
      },
    );

    expect(await findByAltText("settings.avatarPreview")).toHaveAttribute(
      "src",
      `${window.location.origin}/api/public/mock-public-key/profile/avatar?v=1`,
    );

    const user = userEvent.setup();
    await user.upload(
      getByLabelText("settings.uploadAvatar"),
      new File(["png"], "avatar.png", { type: "image/png" }),
    );
    await user.click(getByRole("button", { name: "confirm-avatar-crop" }));

    await waitFor(() => {
      expect(mockPutBinary).toHaveBeenCalled();
    });
    expect(toast.success).not.toHaveBeenCalledWith("settings.avatarUploadSuccess");
    expect(toast.error).toHaveBeenCalledWith("settings.avatarUploadError");
    expect(queryByText("confirm-avatar-crop")).toBeInTheDocument();
  });

  it("shows delete avatar CTA, deletes avatar, and refreshes preview version", async () => {
    let profileCalls = 0;
    const mockGet = vi.fn((path: string) => {
      if (path === "/api/mock-public-key/api-tokens") {
        return Promise.resolve({ items: [] });
      }

      if (path === "/api/mock-public-key/profile") {
        profileCalls += 1;
        return Promise.resolve({
          data:
            profileCalls === 1
              ? createProfile({ displayName: "Z", bio: "hello", hasAvatar: true, avatarVersion: 1 })
              : createProfile({
                  displayName: "Z",
                  bio: "hello",
                  hasAvatar: false,
                  avatarVersion: null,
                }),
        });
      }

      return Promise.reject(new Error(`unexpected path: ${path}`));
    });
    const mockDelete = vi.fn().mockResolvedValue(undefined);

    const { findByRole, queryByAltText, queryByRole } = renderWithProviders(<SettingsPage />, {
      authState: {
        apiClient: {
          get: mockGet,
          post: vi.fn(),
          put: vi.fn(),
          putBinary: vi.fn(),
          del: mockDelete,
          streamPost: vi.fn(),
          ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
        } as unknown as ApiClient,
      },
    });

    const user = userEvent.setup();
    await user.click(await findByRole("button", { name: "settings.deleteAvatar" }));

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith("/api/mock-public-key/profile/avatar");
    });

    await waitFor(() => {
      expect(queryByAltText("settings.avatarPreview")).not.toBeInTheDocument();
      expect(queryByRole("button", { name: "settings.deleteAvatar" })).not.toBeInTheDocument();
    });
    expect(toast.success).toHaveBeenCalledWith("settings.avatarDeleteSuccess");
  });

  it("loads existing api tokens and shows the full token id in the list", async () => {
    const mockGet = vi.fn((path: string) => {
      if (path === "/api/mock-public-key/profile") {
        return Promise.resolve({ data: createProfile() });
      }

      if (path === "/api/mock-public-key/api-tokens") {
        return Promise.resolve({
          items: [
            {
              id: "sk-secret-token",
              tokenPrefix: "sk-sec...",
              note: "Cursor local",
              createdAt: "2026-03-25T00:00:00.000Z",
            },
          ],
        });
      }

      return Promise.reject(new Error(`unexpected path: ${path}`));
    });

    const { findByText, queryByText } = renderWithProviders(<SettingsPage />, {
      authState: {
        apiClient: {
          get: mockGet,
          post: vi.fn(),
          put: vi.fn(),
          putBinary: vi.fn(),
          del: vi.fn(),
          streamPost: vi.fn(),
          ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
        } as unknown as ApiClient,
      },
    });

    expect(await findByText("settings.apiTokens")).toBeInTheDocument();
    expect(await findByText("Cursor local")).toBeInTheDocument();
    expect(await findByText("sk-secret-token")).toBeInTheDocument();
    expect(await findByText("2026-03-25T00:00:00.000Z")).toBeInTheDocument();
  });

  it("creates an api token, keeps the full token visible, and deletes it from the local list", async () => {
    const mockGet = vi.fn((path: string) => {
      if (path === "/api/mock-public-key/profile") {
        return Promise.resolve({ data: createProfile() });
      }

      if (path === "/api/mock-public-key/api-tokens") {
        return Promise.resolve({ items: [] });
      }

      return Promise.reject(new Error(`unexpected path: ${path}`));
    });
    const mockPost = vi.fn().mockResolvedValue({
      id: "sk-created-secret",
      note: "CLI",
      createdAt: "2026-03-25T00:00:00.000Z",
    });
    const mockDelete = vi.fn().mockResolvedValue(undefined);

    const {
      findByRole,
      getByLabelText,
      findAllByText,
      findByText,
      queryByText,
      queryByDisplayValue,
    } = renderWithProviders(<SettingsPage />, {
      authState: {
        apiClient: {
          get: mockGet,
          post: mockPost,
          put: vi.fn(),
          putBinary: vi.fn(),
          del: mockDelete,
          streamPost: vi.fn(),
          ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
        } as unknown as ApiClient,
      },
    });

    const user = userEvent.setup();
    await user.type(await getByLabelText("settings.apiTokenNote"), "CLI");
    await user.click(await findByRole("button", { name: "settings.createApiToken" }));

    expect(mockPost).toHaveBeenCalledWith("/api/mock-public-key/api-tokens", { note: "CLI" });
    expect(await findAllByText("sk-created-secret")).toHaveLength(2);
    expect(await findByText("CLI")).toBeInTheDocument();
    expect(queryByDisplayValue("CLI")).not.toBeInTheDocument();

    await user.click(await findByRole("button", { name: "settings.deleteApiToken" }));

    expect(mockDelete).toHaveBeenCalledWith("/api/mock-public-key/api-tokens/sk-created-secret");
    await waitFor(() => {
      expect(queryByText("sk-created-secret")).not.toBeInTheDocument();
    });
  });

  it("does not show avatar delete success if the refresh fails", async () => {
    const mockGet = vi
      .fn()
      .mockResolvedValueOnce({
        data: createProfile({ displayName: "Z", bio: "hello", hasAvatar: true, avatarVersion: 1 }),
      })
      .mockRejectedValueOnce(new Error("refresh failed"));
    const mockDelete = vi.fn().mockResolvedValue(undefined);

    const { findByRole, queryByAltText } = renderWithProviders(<SettingsPage />, {
      authState: {
        apiClient: {
          get: mockGet,
          post: vi.fn(),
          put: vi.fn(),
          putBinary: vi.fn(),
          del: mockDelete,
          streamPost: vi.fn(),
          ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
        } as unknown as ApiClient,
      },
    });

    const user = userEvent.setup();
    await user.click(await findByRole("button", { name: "settings.deleteAvatar" }));

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith("/api/mock-public-key/profile/avatar");
    });
    expect(toast.success).not.toHaveBeenCalledWith("settings.avatarDeleteSuccess");
    expect(toast.error).toHaveBeenCalledWith("settings.avatarDeleteError");
    expect(queryByAltText("settings.avatarPreview")).toBeInTheDocument();
  });
});
