import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import type { ApiClient } from "../lib/api-client";
import type { ApprovalAsset } from "../lib/approval-api";

type Anchor = ApprovalAsset;

function createRequestId() {
  return globalThis.crypto.randomUUID();
}

export function useAnchors(apiClient: ApiClient) {
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const requestIdsRef = useRef(new Map<string, string>());

  const claimRequestId = useCallback((mutationKey: string) => {
    const existing = requestIdsRef.current.get(mutationKey);
    if (existing) {
      return existing;
    }

    const requestId = createRequestId();
    requestIdsRef.current.set(mutationKey, requestId);
    return requestId;
  }, []);

  const clearRequestId = useCallback((mutationKey: string) => {
    requestIdsRef.current.delete(mutationKey);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const path = apiClient.ownerPath("/anchors?limit=200");
      const res = await apiClient.get<{
        data: { items: Anchor[]; total: number };
      }>(path);
      setAnchors(res.data.items);
      setTotal(res.data.total);
    } catch {
      setAnchors([]);
      setTotal(0);
      toast.error("Operation failed");
    } finally {
      setLoading(false);
    }
  }, [apiClient]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async (question: string, answer?: string) => {
    try {
      const path = apiClient.ownerPath("/anchors");
      await apiClient.post(path, { question, answer, source: "manual" });
      await load();
      toast.success("Done");
    } catch {
      toast.error("Operation failed");
    }
  };

  const update = async (id: string, data: { question?: string; answer?: string | null }) => {
    const mutationKey = JSON.stringify([
      "micro-edit",
      id,
      data.question ?? null,
      data.answer ?? null,
    ]);
    const requestId = claimRequestId(mutationKey);

    try {
      const path = apiClient.ownerPath(`/anchors/${id}`);
      await apiClient.put<{ data: { actionId: string; asset: Anchor } }>(path, {
        ...data,
        requestId,
      });
      await load();
      clearRequestId(mutationKey);
      toast.success("Done");
    } catch {
      toast.error("Operation failed");
    }
  };

  const remove = async (id: string) => {
    const mutationKey = JSON.stringify(["deny", id]);
    const requestId = claimRequestId(mutationKey);

    try {
      const path = apiClient.ownerPath(`/anchors/${id}/deny`);
      await apiClient.post<{ data: { actionId: string; asset: Anchor } }>(path, { requestId });
      await load();
      clearRequestId(mutationKey);
      toast.success("Done");
    } catch {
      toast.error("Operation failed");
    }
  };

  return { anchors, total, loading, create, update, remove, reload: load };
}
