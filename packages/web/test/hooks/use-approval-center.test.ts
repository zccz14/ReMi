// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/lib/api-client";
import {
  type ApprovalApi,
  type ApprovalCandidate,
  useApprovalCenter,
} from "../../src/hooks/use-approval-center";

const anchorCandidate: ApprovalCandidate = {
  id: "candidate-1",
  ownerKey: "owner-key",
  question: "What matters most?",
  answer: "Trust",
  source: "reading",
  sourceRef: "reading:1",
  sourceSnapshot: { excerpt: "Trust is the floor." },
  createdAt: 100,
  kind: "anchor",
};

function createApprovalApiMock(overrides?: Partial<ApprovalApi>): ApprovalApi {
  return {
    listCandidates: vi.fn().mockResolvedValue({
      items: [anchorCandidate],
      total: 1,
      limit: 50,
      offset: 0,
    }),
    approveCandidate: vi.fn().mockResolvedValue({ actionId: "action-1", asset: null }),
    rejectCandidate: vi.fn().mockResolvedValue({ actionId: "action-2", asset: null }),
    skipCandidate: vi.fn().mockResolvedValue({ actionId: "action-3", asset: null }),
    undo: vi.fn().mockResolvedValue({ actionId: "action-1", restoredCandidate: anchorCandidate }),
    ...overrides,
  };
}

describe("useApprovalCenter", () => {
  it("loads candidates for the current kind", async () => {
    const api = createApprovalApiMock();
    const { result } = renderHook(() =>
      useApprovalCenter({ api, kind: "anchor", requestIdFactory: () => "req-1" }),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(api.listCandidates).toHaveBeenCalledWith("anchor");
    expect(result.current.candidates).toEqual([anchorCandidate]);
  });

  it("submits approve and undo actions while tracking lastActionId", async () => {
    const api = createApprovalApiMock();
    const { result } = renderHook(() =>
      useApprovalCenter({ api, kind: "anchor", requestIdFactory: () => "req-1" }),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.approve(anchorCandidate);
    });

    expect(api.approveCandidate).toHaveBeenCalledWith({
      candidateId: "candidate-1",
      requestId: "req-1",
      action: "approve",
      mode: "create_new",
    });
    expect(result.current.candidates).toEqual([]);
    expect(result.current.lastActionId).toBe("action-1");

    await act(async () => {
      await result.current.undo();
    });

    expect(api.undo).toHaveBeenCalledWith({ actionId: "action-1" });
    expect(result.current.candidates).toEqual([anchorCandidate]);
    expect(result.current.lastActionId).toBeNull();
  });

  it("reuses the same requestId when retrying the same user mutation", async () => {
    const api = createApprovalApiMock({
      rejectCandidate: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary"))
        .mockResolvedValueOnce({ actionId: "action-2", asset: null }),
    });
    const requestIds = ["req-1", "req-2"];
    const { result } = renderHook(() =>
      useApprovalCenter({
        api,
        kind: "anchor",
        requestIdFactory: () => requestIds.shift() ?? "req-fallback",
      }),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await expect(result.current.reject(anchorCandidate)).rejects.toThrow("temporary");
    });

    await act(async () => {
      await result.current.reject(anchorCandidate);
    });

    expect(api.rejectCandidate).toHaveBeenNthCalledWith(1, {
      candidateId: "candidate-1",
      requestId: "req-1",
    });
    expect(api.rejectCandidate).toHaveBeenNthCalledWith(2, {
      candidateId: "candidate-1",
      requestId: "req-1",
    });
  });

  it("reopens a candidate when update-existing approval is rejected as stale", async () => {
    const probeCandidate = { ...anchorCandidate, id: "candidate-2" };
    const api = createApprovalApiMock({
      listCandidates: vi.fn().mockResolvedValue({
        items: [anchorCandidate, probeCandidate],
        total: 2,
        limit: 50,
        offset: 0,
      }),
      approveCandidate: vi
        .fn()
        .mockRejectedValue(new ApiError(409, "STALE_TARGET", "stale target")),
    });
    const { result } = renderHook(() =>
      useApprovalCenter({ api, kind: "anchor", requestIdFactory: () => "req-1" }),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await expect(
        result.current.keepQuestionOnly(anchorCandidate, {
          mode: "update_existing",
          targetAssetId: "asset-1",
          targetUpdatedAt: 42,
        }),
      ).rejects.toMatchObject({ code: "STALE_TARGET" });
    });

    expect(result.current.candidates).toEqual([anchorCandidate, probeCandidate]);
  });
});
