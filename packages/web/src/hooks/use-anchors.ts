import { useState, useEffect, useCallback } from "react";
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
    const path = apiClient.ownerPath("/anchors?limit=200");
    const res = await apiClient.get<{
      data: { items: Anchor[]; total: number };
    }>(path);
    setAnchors(res.data.items);
    setLoading(false);
  }, [apiClient]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async (question: string, answer?: string) => {
    const path = apiClient.ownerPath("/anchors");
    await apiClient.post(path, { question, answer, source: "manual" });
    await load();
  };

  const update = async (id: string, data: { question?: string; answer?: string | null }) => {
    const path = apiClient.ownerPath(`/anchors/${id}`);
    await apiClient.put(path, data);
    await load();
  };

  const remove = async (id: string) => {
    const path = apiClient.ownerPath(`/anchors/${id}`);
    await apiClient.del(path);
    await load();
  };

  return { anchors, loading, create, update, remove, reload: load };
}
