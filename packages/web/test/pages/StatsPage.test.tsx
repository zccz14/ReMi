import { describe, it, expect, afterEach, vi } from "vitest";
import { renderWithProviders, cleanup, waitFor } from "../helpers/test-utils";
import { StatsPage } from "../../src/pages/StatsPage";

afterEach(cleanup);

describe("StatsPage", () => {
  it("shows loading skeletons initially", () => {
    const { container } = renderWithProviders(<StatsPage />, {
      authState: {
        apiClient: {
          get: vi.fn(() => new Promise(() => {})),
          post: vi.fn(),
          put: vi.fn(),
          del: vi.fn(),
          streamPost: vi.fn(),
          ownerPath: vi.fn((p: string) => `/api/mock-public-key${p}`),
        } as any,
      },
    });

    const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("loads and shows current interview stats", async () => {
    const mockGet = vi.fn().mockResolvedValue({
      data: { totalAnchors: 5, totalMessages: 42, lastActiveAt: 1710000000000 },
    });
    const mockOwnerPath = vi.fn((p: string) => `/api/mock-public-key${p}`);

    const { getByText } = renderWithProviders(<StatsPage />, {
      authState: {
        apiClient: {
          get: mockGet,
          post: vi.fn(),
          put: vi.fn(),
          del: vi.fn(),
          streamPost: vi.fn(),
          ownerPath: mockOwnerPath,
        } as any,
      },
    });

    await waitFor(() => {
      expect(mockOwnerPath).toHaveBeenCalledWith("/interview/status");
      expect(mockGet).toHaveBeenCalledWith("/api/mock-public-key/interview/status");
      expect(getByText("5")).toBeInTheDocument();
    });

    expect(getByText("42")).toBeInTheDocument();
    expect(getByText(new RegExp(new Date(1710000000000).toLocaleDateString()))).toBeInTheDocument();
  });

  it("shows a never-active fallback when there is no last active time", async () => {
    const mockGet = vi.fn().mockResolvedValue({
      data: { totalAnchors: 0, totalMessages: 0, lastActiveAt: null },
    });

    const { getByText } = renderWithProviders(<StatsPage />, {
      authState: {
        apiClient: {
          get: mockGet,
          post: vi.fn(),
          put: vi.fn(),
          del: vi.fn(),
          streamPost: vi.fn(),
          ownerPath: vi.fn((p: string) => `/api/mock-public-key${p}`),
        } as any,
      },
    });

    await waitFor(() => {
      expect(getByText(/dashboard\.never/)).toBeInTheDocument();
    });
  });
});
