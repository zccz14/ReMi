// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
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
    source: "interview" as const,
    createdAt: 2000,
    updatedAt: 2000,
  },
];

function createMockApiClient() {
  return {
    ownerPath: vi.fn((p: string) => "/api/test-key" + p),
    get: vi.fn().mockResolvedValue({ data: { items: mockAnchors, total: 2 } }),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    del: vi.fn().mockResolvedValue(undefined),
  } as unknown as ApiClient;
}

describe("useAnchors", () => {
  it("should load anchors on mount", async () => {
    const api = createMockApiClient();
    const { result } = renderHook(() => useAnchors(api));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(api.ownerPath).toHaveBeenCalledWith("/anchors?limit=200");
    expect(api.get).toHaveBeenCalledWith("/api/test-key/anchors?limit=200");
    expect(result.current.anchors).toEqual(mockAnchors);
  });

  it("should create an anchor and reload", async () => {
    const api = createMockApiClient();
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
    // Once on mount + once after create
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenCalledWith("Done");
  });

  it("should update an anchor and reload", async () => {
    const api = createMockApiClient();
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
    });
    // Once on mount + once after update
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenCalledWith("Done");
  });

  it("should remove an anchor and reload", async () => {
    const api = createMockApiClient();
    const { result } = renderHook(() => useAnchors(api));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.remove("a1");
    });

    expect(api.ownerPath).toHaveBeenCalledWith("/anchors/a1");
    expect(api.del).toHaveBeenCalledWith("/api/test-key/anchors/a1");
    // Once on mount + once after remove
    expect(api.get).toHaveBeenCalledTimes(2);
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
  });
});
