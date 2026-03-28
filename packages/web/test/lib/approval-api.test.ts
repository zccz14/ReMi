import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/lib/api-client";
import { createApprovalApi } from "../../src/lib/approval-api";

describe("createApprovalApi", () => {
  it("lists approval candidates for the current kind", async () => {
    const apiClient = {
      ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
      get: vi.fn().mockResolvedValue({
        data: {
          items: [
            {
              id: "candidate-1",
              ownerKey: "mock-public-key",
              question: "What matters most?",
              answer: "Trust",
              source: "reading",
              sourceRef: "reading:1",
              sourceSnapshot: '{"excerpt":"Trust is the floor."}',
              createdAt: 100,
              kind: "anchor",
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        },
      }),
    } as unknown as ApiClient;

    const api = createApprovalApi(apiClient);
    const result = await api.listCandidates("anchor");

    expect(apiClient.ownerPath).toHaveBeenCalledWith("/approval/candidates?kind=anchor");
    expect(apiClient.get).toHaveBeenCalledWith(
      "/api/mock-public-key/approval/candidates?kind=anchor",
    );
    expect(result.items[0]?.sourceSnapshot).toEqual({ excerpt: "Trust is the floor." });
  });

  it("posts approve mutations with request ids", async () => {
    const apiClient = {
      ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
      post: vi.fn().mockResolvedValue({ data: { actionId: "action-1", asset: null } }),
    } as unknown as ApiClient;

    const api = createApprovalApi(apiClient);

    await api.approveCandidate({
      candidateId: "candidate-1",
      requestId: "req-1",
      action: "approve",
      mode: "update_existing",
      targetAssetId: "asset-1",
      targetUpdatedAt: 42,
    });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/api/mock-public-key/approval/candidates/candidate-1/approve",
      {
        requestId: "req-1",
        action: "approve",
        mode: "update_existing",
        targetAssetId: "asset-1",
        targetUpdatedAt: 42,
        question: undefined,
        answer: undefined,
      },
    );
  });

  it("posts edited text with approval mutations", async () => {
    const apiClient = {
      ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
      post: vi.fn().mockResolvedValue({ data: { actionId: "action-1", asset: null } }),
    } as unknown as ApiClient;

    const api = createApprovalApi(apiClient);

    await api.approveCandidate({
      candidateId: "candidate-1",
      requestId: "req-2",
      action: "question_only",
      mode: "update_existing",
      targetAssetId: "asset-1",
      targetUpdatedAt: 42,
      question: "What still matters most?",
      answer: "Trust after pressure.",
    });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/api/mock-public-key/approval/candidates/candidate-1/approve",
      {
        requestId: "req-2",
        action: "question_only",
        mode: "update_existing",
        targetAssetId: "asset-1",
        targetUpdatedAt: 42,
        question: "What still matters most?",
        answer: "Trust after pressure.",
      },
    );
  });

  it("posts reject, skip, and undo mutations", async () => {
    const apiClient = {
      ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
      post: vi.fn().mockResolvedValue({ data: { actionId: "action-1", asset: null } }),
    } as unknown as ApiClient;

    const api = createApprovalApi(apiClient);

    await api.rejectCandidate({ candidateId: "candidate-1", requestId: "req-1" });
    await api.skipCandidate({ candidateId: "candidate-2", requestId: "req-2" });
    await api.undo({ actionId: "action-1" });

    expect(apiClient.post).toHaveBeenNthCalledWith(
      1,
      "/api/mock-public-key/approval/candidates/candidate-1/reject",
      { requestId: "req-1" },
    );
    expect(apiClient.post).toHaveBeenNthCalledWith(
      2,
      "/api/mock-public-key/approval/candidates/candidate-2/skip",
      { requestId: "req-2" },
    );
    expect(apiClient.post).toHaveBeenNthCalledWith(3, "/api/mock-public-key/approval/undo", {
      actionId: "action-1",
    });
  });
});
