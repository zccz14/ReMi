// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAnchors } from "../../src/hooks/use-anchors";
import type { ApiClient } from "../../src/lib/api-client";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const mockAnchors = [
  {
    id: "a1",
    question: "What is ReMi?",
    answer: "A tool",
    source: "manual" as const,
    createdAt: 1000,
    updatedAt: 1000,
  },
  {
    id: "a2",
    question: "How does it work?",
    answer: null,
    source: "reading" as const,
    createdAt: 2000,
    updatedAt: 2000,
  },
];

const reloadedAnchors = [
  {
    id: "a3",
    question: "Reloaded anchor",
    answer: "Reloaded answer",
    source: "manual" as const,
    createdAt: 3000,
    updatedAt: 4000,
  },
];

function createMockApiClient(options?: {
  getResponses?: Array<{ data: { items: typeof mockAnchors; total: number } }>;
}) {
  const get = vi.fn();
  const responses = options?.getResponses;

  if (responses?.length) {
    for (const response of responses) {
      get.mockResolvedValueOnce(response);
    }
  } else {
    get.mockResolvedValue({ data: { items: mockAnchors, total: 2 } });
  }

  return {
    ownerPath: vi.fn((p: string) => "/api/test-key" + p),
    get,
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
  } as unknown as ApiClient;
}

describe("useAnchors", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it("should load anchors on mount", async () => {
    const api = createMockApiClient();
    const { result } = renderHook(() => useAnchors(api));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(api.ownerPath).toHaveBeenCalledWith("/anchors?limit=200");
    expect(api.get).toHaveBeenCalledWith("/api/test-key/anchors?limit=200");
    expect(result.current.anchors).toEqual(mockAnchors);
    expect(result.current.total).toBe(2);
  });

  it("should create an anchor and reload", async () => {
    const api = createMockApiClient({
      getResponses: [
        { data: { items: mockAnchors, total: 2 } },
        { data: { items: reloadedAnchors, total: 3 } },
      ],
    });
    const { result } = renderHook(() => useAnchors(api));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.create("New question", "New answer");
    });

    expect(api.ownerPath).toHaveBeenCalledWith("/anchors");
    expect(api.post).toHaveBeenCalledWith("/api/test-key/anchors", {
      question: "New question",
      answer: "New answer",
      source: "manual",
    });
    expect(result.current.anchors).toEqual(reloadedAnchors);
    expect(result.current.total).toBe(3);
    expect(toast.success).toHaveBeenCalledWith("Done");
  });

  it("should update an anchor and reload", async () => {
    const requestId = "11111111-1111-1111-1111-111111111111";
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(requestId);
    const api = createMockApiClient({
      getResponses: [
        { data: { items: mockAnchors, total: 2 } },
        { data: { items: reloadedAnchors, total: 5 } },
      ],
    });
    const { result } = renderHook(() => useAnchors(api));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.update("a1", { question: "Updated question" });
    });

    expect(api.ownerPath).toHaveBeenCalledWith("/anchors/a1");
    expect(api.put).toHaveBeenCalledWith("/api/test-key/anchors/a1", {
      question: "Updated question",
      requestId,
    });
    expect(result.current.anchors).toEqual(reloadedAnchors);
    expect(result.current.total).toBe(5);
    expect(toast.success).toHaveBeenCalledWith("Done");
  });

  it("should deny an anchor instead of calling legacy delete", async () => {
    const requestId = "22222222-2222-2222-2222-222222222222";
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(requestId);
    const api = createMockApiClient({
      getResponses: [
        { data: { items: mockAnchors, total: 2 } },
        { data: { items: reloadedAnchors, total: 1 } },
      ],
    });
    const { result } = renderHook(() => useAnchors(api));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.remove("a1");
    });

    expect(api.ownerPath).toHaveBeenNthCalledWith(2, "/anchors/a1/deny");
    expect(api.post).toHaveBeenCalledWith("/api/test-key/anchors/a1/deny", { requestId });
    expect(result.current.anchors).toEqual(reloadedAnchors);
    expect(result.current.total).toBe(1);
    expect(toast.success).toHaveBeenCalledWith("Done");
  });

  it("should call toast.error when load fails", async () => {
    const api = createMockApiClient();
    (api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() => useAnchors(api));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(toast.error).toHaveBeenCalledWith("Operation failed");
    expect(result.current.anchors).toEqual([]);
    expect(result.current.total).toBe(0);
  });
});
