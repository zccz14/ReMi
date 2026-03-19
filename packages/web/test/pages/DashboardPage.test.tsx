import { describe, it, expect, afterEach, vi } from "vitest";
import { renderWithProviders, cleanup, waitFor } from "../helpers/test-utils";
import { DashboardPage } from "../../src/pages/DashboardPage";

afterEach(cleanup);

describe("DashboardPage", () => {
  it("shows loading skeletons initially", () => {
    const { container } = renderWithProviders(<DashboardPage />, {
      authState: {
        apiClient: {
          get: vi.fn(() => new Promise(() => {})), // never resolves
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

  it("shows stats after API returns data", async () => {
    const mockGet = vi.fn().mockResolvedValue({
      data: { totalAnchors: 5, totalMessages: 42, lastActiveAt: 1710000000000 },
    });

    const { getByText } = renderWithProviders(<DashboardPage />, {
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
      expect(getByText("5")).toBeInTheDocument();
    });
    expect(getByText("42")).toBeInTheDocument();
    // lastActiveAt should be formatted as a date
    const dateStr = new Date(1710000000000).toLocaleDateString();
    expect(getByText(new RegExp(dateStr))).toBeInTheDocument();
  });

  it("has navigation links to /interview, /anchors, /share", () => {
    const { container } = renderWithProviders(<DashboardPage />, {
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

    const links = container.querySelectorAll("a");
    const hrefs = Array.from(links).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/interview");
    expect(hrefs).toContain("/anchors");
    expect(hrefs).toContain("/share");
  });
});
