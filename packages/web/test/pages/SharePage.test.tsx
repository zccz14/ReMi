import type { PublicProfile } from "../../src/lib/profile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderWithProviders, userEvent, waitFor } from "../helpers/test-utils";

const { mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock("qrcode.react", () => ({
  QRCodeSVG: (props: any) => (
    <svg
      data-testid="share-qr-svg"
      data-value={props.value}
      data-image-src={props.imageSettings?.src ?? "none"}
      data-level={props.level}
    />
  ),
}));

vi.mock("sonner", () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

import { SharePage } from "../../src/pages/SharePage";

const SharePageWithFutureProps = SharePage as unknown as (props: {
  forceQrImageFallback?: "auto" | "logo" | "none";
}) => ReturnType<typeof SharePage>;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function createProfile(overrides?: Partial<PublicProfile>): PublicProfile {
  return {
    displayName: "Alice",
    bio: "Human, builder, and friendly ReMi contact.",
    hasAvatar: true,
    avatarVersion: 3,
    updatedAt: 123,
    ...overrides,
  };
}

function createApiClient(result: Promise<{ data: PublicProfile }> | { data: PublicProfile }) {
  return {
    get: vi.fn(() => Promise.resolve(result)),
    post: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
    streamPost: vi.fn(),
    ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function mockImageProbeSequence(sequence: Array<{ ok: boolean }>) {
  let index = 0;

  vi.stubGlobal(
    "Image",
    class {
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;

      set src(_value: string) {
        const current = sequence[index++] ?? sequence[sequence.length - 1];
        queueMicrotask(() => {
          if (current?.ok) {
            this.onload?.();
          } else {
            this.onerror?.();
          }
        });
      }
    } as unknown as typeof Image,
  );
}

describe("SharePage", () => {
  it("renders the personal-card copy and resolved profile data after bootstrap", async () => {
    const { getByText, getByTestId } = renderWithProviders(<SharePage />, {
      authState: { apiClient: createApiClient({ data: createProfile() }) as any },
    });

    await waitFor(() => expect(getByText("来 ReMi 链接我")).toBeInTheDocument());
    expect(getByText("Alice")).toBeInTheDocument();
    expect(getByText("Human, builder, and friendly ReMi contact.")).toBeInTheDocument();
    expect(getByTestId("share-card")).toBeInTheDocument();
    expect(getByTestId("share-link")).toHaveTextContent(
      "http://localhost:3000/profile/mock-public-key",
    );
  });

  it("falls back to truncated public key and hides the bio when profile fields are empty", async () => {
    const { getByText, queryByTestId } = renderWithProviders(<SharePage />, {
      authState: {
        apiClient: createApiClient({
          data: createProfile({
            displayName: "   ",
            bio: "   ",
            hasAvatar: false,
            avatarVersion: null,
          }),
        }) as any,
      },
    });

    await waitFor(() => expect(getByText("mock-p...-key")).toBeInTheDocument());
    expect(queryByTestId("share-card-bio")).toBeNull();
  });

  it("uses avatar image settings for the QR code when avatar metadata exists", async () => {
    const { getByTestId } = renderWithProviders(<SharePage />, {
      authState: { apiClient: createApiClient({ data: createProfile() }) as any },
    });

    await waitFor(() => expect(getByTestId("share-qr-svg")).toBeInTheDocument());
    expect(getByTestId("share-qr-svg")).toHaveAttribute(
      "data-image-src",
      expect.stringContaining("/api/public/mock-public-key/profile/avatar?v=3"),
    );
    expect(getByTestId("share-qr-svg")).toHaveAttribute("data-level", "H");
    expect(getByTestId("share-qr-wrapper")).toHaveAttribute("data-center-image-kind", "avatar");
  });

  it("falls back to the app logo when no avatar metadata exists", async () => {
    const { getByTestId } = renderWithProviders(<SharePage />, {
      authState: {
        apiClient: createApiClient({
          data: createProfile({ hasAvatar: false, avatarVersion: null }),
        }) as any,
      },
    });

    await waitFor(() => expect(getByTestId("share-qr-svg")).toBeInTheDocument());
    expect(getByTestId("share-qr-svg")).toHaveAttribute("data-image-src", "/icons/icon-192.png");
    expect(getByTestId("share-qr-wrapper")).toHaveAttribute("data-center-image-kind", "logo");
  });

  it("falls back to a pure qr when center images are forced off", async () => {
    const { getByTestId } = renderWithProviders(
      <SharePageWithFutureProps forceQrImageFallback="none" />,
      {
        authState: {
          apiClient: createApiClient({
            data: createProfile({ hasAvatar: false, avatarVersion: null }),
          }) as any,
        },
      },
    );

    await waitFor(() => expect(getByTestId("share-qr-svg")).toBeInTheDocument());
    expect(getByTestId("share-qr-svg")).toHaveAttribute("data-image-src", "none");
    expect(getByTestId("share-qr-wrapper")).toHaveAttribute("data-center-image-kind", "none");
  });

  it("falls back from avatar to logo when the avatar probe fails", async () => {
    mockImageProbeSequence([{ ok: false }, { ok: true }]);

    const { getByTestId } = renderWithProviders(<SharePage />, {
      authState: { apiClient: createApiClient({ data: createProfile() }) as any },
    });

    await waitFor(() => {
      expect(getByTestId("share-qr-wrapper")).toHaveAttribute("data-center-image-kind", "logo");
    });
    expect(getByTestId("share-qr-svg")).toHaveAttribute("data-image-src", "/icons/icon-192.png");
  });

  it("falls back from logo to pure qr when both probes fail", async () => {
    mockImageProbeSequence([{ ok: false }, { ok: false }]);

    const { getByTestId } = renderWithProviders(<SharePage />, {
      authState: { apiClient: createApiClient({ data: createProfile() }) as any },
    });

    await waitFor(() => {
      expect(getByTestId("share-qr-wrapper")).toHaveAttribute("data-center-image-kind", "none");
    });
    expect(getByTestId("share-qr-svg")).toHaveAttribute("data-image-src", "none");
  });

  it("keeps the card shell visible while loading and after bootstrap failure", async () => {
    const deferred = createDeferred<{ data: PublicProfile }>();
    const loading = renderWithProviders(<SharePage />, {
      authState: { apiClient: createApiClient(deferred.promise) as any },
    });

    expect(loading.getByTestId("share-card")).toBeInTheDocument();
    expect(loading.getByTestId("share-loading")).toBeInTheDocument();
    expect(loading.queryByTestId("share-qr-wrapper")).toBeNull();
    expect(loading.queryByTestId("share-link")).toBeNull();
    expect(loading.getByRole("button", { name: "复制链接" })).toBeDisabled();

    const failed = renderWithProviders(<SharePage />, {
      authState: {
        apiClient: {
          ...createApiClient({ data: createProfile() }),
          get: vi.fn().mockRejectedValue(new Error("bootstrap failed")),
        } as any,
      },
    });

    await waitFor(() => expect(failed.getByTestId("share-error")).toBeInTheDocument());
    expect(failed.getByTestId("share-card")).toBeInTheDocument();
    expect(failed.queryByTestId("share-qr-wrapper")).toBeNull();
    expect(failed.queryByTestId("share-link")).toBeNull();
    expect(failed.getByRole("button", { name: "复制链接" })).toBeDisabled();
  });

  it("copies the share link and shows the refreshed success toast", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const { getByRole } = renderWithProviders(<SharePage />, {
      authState: { apiClient: createApiClient({ data: createProfile() }) as any },
    });

    await waitFor(() => expect(getByRole("button", { name: "复制链接" })).toBeEnabled());
    await userEvent.click(getByRole("button", { name: "复制链接" }));

    expect(writeText).toHaveBeenCalledWith("http://localhost:3000/profile/mock-public-key");
    expect(mockToastSuccess).toHaveBeenCalledWith("链接已复制，发给朋友吧");
  });
});
