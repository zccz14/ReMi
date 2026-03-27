import { describe, it, expect, afterEach, vi } from "vitest";
import { renderWithProviders, cleanup, waitFor } from "../helpers/test-utils";

vi.mock("qrcode.react", () => ({
  QRCodeSVG: (props: any) => <svg data-testid="qr-code" data-value={props.value} />,
}));

import { SharePage } from "../../src/pages/SharePage";

const shareText = {
  bootstrapping: "正在准备公开资料…",
  bootstrapError: "公开资料准备失败，请稍后重试。",
  copyLink: "复制链接",
};

afterEach(cleanup);

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SharePage", () => {
  it("bootstraps the owner profile before sharing the public link", async () => {
    const mockGet = vi.fn().mockResolvedValue({
      data: {
        displayName: "",
        bio: "",
        hasAvatar: false,
        avatarVersion: null,
        updatedAt: null,
      },
    });
    const ownerPath = vi.fn((path: string) => `/api/mock-public-key${path}`);

    renderWithProviders(<SharePage />, {
      authState: {
        apiClient: {
          get: mockGet,
          post: vi.fn(),
          put: vi.fn(),
          del: vi.fn(),
          streamPost: vi.fn(),
          ownerPath,
        } as any,
      },
    });

    await waitFor(() => {
      expect(ownerPath).toHaveBeenCalledWith("/profile");
      expect(mockGet).toHaveBeenCalledWith("/api/mock-public-key/profile");
    });
  });

  it("shows the share URL containing the public key after bootstrap succeeds", async () => {
    const { getByText } = renderWithProviders(<SharePage />);

    await waitFor(() => {
      expect(getByText(/mock-public-key/)).toBeInTheDocument();
    });
  });

  it("keeps share actions disabled until bootstrap succeeds", async () => {
    const bootstrap = createDeferred<{ data: unknown }>();

    const { getByText, queryByTestId } = renderWithProviders(<SharePage />, {
      authState: {
        apiClient: {
          get: vi.fn(() => bootstrap.promise),
          post: vi.fn(),
          put: vi.fn(),
          del: vi.fn(),
          streamPost: vi.fn(),
          ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
        } as any,
      },
    });

    expect(getByText(shareText.bootstrapping)).toBeInTheDocument();
    expect(getByText(shareText.copyLink)).toBeDisabled();
    expect(queryByTestId("qr-code")).toBeNull();
    expect(() => getByText(/http:\/\/localhost:3000\/profile\/mock-public-key/)).toThrow();

    bootstrap.resolve({ data: {} });

    await waitFor(() => {
      expect(getByText(shareText.copyLink)).toBeEnabled();
    });
    expect(getByText(/http:\/\/localhost:3000\/profile\/mock-public-key/)).toBeInTheDocument();
  });

  it("shows bootstrap failure and keeps sharing disabled", async () => {
    const { getByText, queryByTestId } = renderWithProviders(<SharePage />, {
      authState: {
        apiClient: {
          get: vi.fn().mockRejectedValue(new Error("bootstrap failed")),
          post: vi.fn(),
          put: vi.fn(),
          del: vi.fn(),
          streamPost: vi.fn(),
          ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
        } as any,
      },
    });

    expect(await waitFor(() => getByText(shareText.bootstrapError))).toBeInTheDocument();
    expect(getByText(shareText.copyLink)).toBeDisabled();
    expect(queryByTestId("qr-code")).toBeNull();
    expect(() => getByText(/http:\/\/localhost:3000\/profile\/mock-public-key/)).toThrow();
  });

  it("renders a QR code after bootstrap succeeds", async () => {
    const { getByTestId } = renderWithProviders(<SharePage />);

    await waitFor(() => {
      expect(getByTestId("qr-code")).toBeInTheDocument();
    });
    expect(getByTestId("qr-code").getAttribute("data-value")).toContain("mock-public-key");
  });
});
