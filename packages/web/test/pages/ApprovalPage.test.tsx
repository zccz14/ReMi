// @vitest-environment jsdom
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/lib/api-client";
import { ApprovalPage } from "../../src/pages/ApprovalPage";
import { fireEvent, renderWithProviders, screen, waitFor } from "../helpers/test-utils";

describe("ApprovalPage", () => {
  it("refreshes assets and queue metadata after stale target conflicts", async () => {
    const apiGet = vi.fn().mockImplementation(async (path: string) => {
      if (path.includes("/approval/candidates?kind=anchor")) {
        return {
          data: {
            items: [
              {
                id: "candidate-1",
                ownerKey: "mock-public-key",
                question: "What matters most?",
                answer: "Trust",
                source: "reading",
                sourceRef: "reading:1",
                sourceSnapshot: '{"excerpt":"Trust"}',
                createdAt: 100,
                kind: "anchor",
              },
            ],
            total: 1,
            limit: 50,
            offset: 0,
          },
        };
      }

      if (path.includes("/anchors?limit=200")) {
        const updatedAt =
          apiGet.mock.calls.filter(([callPath]) => callPath.includes("/anchors?limit=200"))
            .length === 0
            ? 42
            : 84;
        return {
          data: {
            items: [
              {
                id: "asset-1",
                question: "What matters most?",
                answer: "Trust",
                updatedAt,
              },
            ],
          },
        };
      }

      throw new Error(`Unexpected GET ${path}`);
    });
    const apiPost = vi.fn().mockRejectedValue(new ApiError(409, "STALE_TARGET", "stale target"));

    renderWithProviders(
      <Routes>
        <Route path="/approval/:kind" element={<ApprovalPage />} />
      </Routes>,
      {
        route: "/approval/anchors",
        authState: {
          apiClient: {
            get: apiGet,
            post: apiPost,
            put: vi.fn(),
            del: vi.fn(),
            streamPost: vi.fn(),
            ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
          } as never,
        },
      },
    );

    await screen.findByText("What matters most?");

    fireEvent.click(screen.getAllByText("What matters most?")[0]!);
    fireEvent.click(screen.getByLabelText(/Update existing/i));
    fireEvent.change(screen.getByLabelText(/Existing asset/i), { target: { value: "asset-1" } });
    fireEvent.click(screen.getByRole("button", { name: /Approve candidate/i }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      const anchorLoads = apiGet.mock.calls.filter(([path]) => path.includes("/anchors?limit=200"));
      const queueLoads = apiGet.mock.calls.filter(([path]) =>
        path.includes("/approval/candidates?kind=anchor"),
      );
      expect(anchorLoads).toHaveLength(2);
      expect(queueLoads).toHaveLength(2);
    });
  });
});
