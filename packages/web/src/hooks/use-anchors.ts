import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import type { ApiClient } from "../lib/api-client";

interface Anchor {
  id: string;
  question: string;
  answer: string | null;
  source: "interview" | "manual";
  createdAt: number;
  updatedAt: number;
}

export function useAnchors(apiClient: ApiClient) {
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const path = apiClient.ownerPath("/anchors?limit=200");
      const res = await apiClient.get<{
        data: { items: Anchor[]; total: number };
      }>(path);
      setAnchors(res.data.items);
    } catch {
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
    try {
      const path = apiClient.ownerPath(`/anchors/${id}`);
      await apiClient.put(path, data);
      await load();
      toast.success("Done");
    } catch {
      toast.error("Operation failed");
    }
  };

  const remove = async (id: string) => {
    try {
      const path = apiClient.ownerPath(`/anchors/${id}`);
      await apiClient.del(path);
      await load();
      toast.success("Done");
    } catch {
      toast.error("Operation failed");
    }
  };

  return { anchors, loading, create, update, remove, reload: load };
}
