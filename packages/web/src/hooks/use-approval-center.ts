import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalApi,
  ApprovalCandidate,
  ApprovalKind,
  ApprovalWriteMode,
} from "../lib/approval-api";

export type { ApprovalApi, ApprovalCandidate, ApprovalKind } from "../lib/approval-api";

interface UpdateExistingOptions {
  mode?: ApprovalWriteMode;
  targetAssetId?: string;
  targetUpdatedAt?: number;
  question?: string;
  answer?: string | null;
}

interface UseApprovalCenterOptions {
  api: ApprovalApi;
  kind: ApprovalKind;
  requestIdFactory?: () => string;
}

function defaultRequestIdFactory() {
  return globalThis.crypto.randomUUID();
}

function buildMutationKey(
  action: string,
  candidate: ApprovalCandidate,
  options?: UpdateExistingOptions,
) {
  return [
    action,
    candidate.id,
    options?.mode ?? "create_new",
    options?.targetAssetId ?? "",
    options?.targetUpdatedAt ?? "",
    options?.question ?? "",
    options?.answer ?? "",
  ].join(":");
}

export function useApprovalCenter({
  api,
  kind,
  requestIdFactory = defaultRequestIdFactory,
}: UseApprovalCenterOptions) {
  const requestIdsRef = useRef(new Map<string, string>());
  const [candidates, setCandidates] = useState<ApprovalCandidate[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [lastActionId, setLastActionId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, undoState] = await Promise.all([api.listCandidates(kind), api.getUndoState()]);
      setCandidates(data.items);
      setTotal(data.total);
      setLastActionId(undoState?.actionId ?? null);
    } finally {
      setLoading(false);
    }
  }, [api, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const claimRequestId = useCallback(
    (mutationKey: string) => {
      const existing = requestIdsRef.current.get(mutationKey);
      if (existing) {
        return existing;
      }

      const next = requestIdFactory();
      requestIdsRef.current.set(mutationKey, next);
      return next;
    },
    [requestIdFactory],
  );

  const releaseRequestId = useCallback((mutationKey: string) => {
    requestIdsRef.current.delete(mutationKey);
  }, []);

  const removeCandidate = useCallback((candidateId: string) => {
    setCandidates((current) => current.filter((candidate) => candidate.id !== candidateId));
    setTotal((current) => Math.max(0, current - 1));
  }, []);

  const reopenCandidate = useCallback((candidate: ApprovalCandidate) => {
    setCandidates((current) => {
      if (current.some((item) => item.id === candidate.id)) {
        return current;
      }
      return [candidate, ...current];
    });
    setTotal((current) => current + 1);
  }, []);

  const submitApproval = useCallback(
    async (
      candidate: ApprovalCandidate,
      action: "approve" | "question_only",
      options?: UpdateExistingOptions,
    ) => {
      const mutationKey = buildMutationKey(action, candidate, options);
      const requestId = claimRequestId(mutationKey);
      removeCandidate(candidate.id);
      setSubmitting(true);

      try {
        const result = await api.approveCandidate({
          candidateId: candidate.id,
          requestId,
          action,
          mode: options?.mode ?? "create_new",
          targetAssetId: options?.targetAssetId,
          targetUpdatedAt: options?.targetUpdatedAt,
          question: options?.question,
          answer: options?.answer,
        });
        releaseRequestId(mutationKey);
        setLastActionId(result.actionId);
        return result;
      } catch (error) {
        reopenCandidate(candidate);
        const code = typeof error === "object" && error && "code" in error ? error.code : null;
        if (code !== "STALE_TARGET") {
          // keep request id stable for retries of the same user mutation
        }
        if (code === "STALE_TARGET") {
          releaseRequestId(mutationKey);
        }
        throw error;
      } finally {
        setSubmitting(false);
      }
    },
    [api, claimRequestId, releaseRequestId, removeCandidate, reopenCandidate],
  );

  const submitCandidateMutation = useCallback(
    async (
      candidate: ApprovalCandidate,
      action: "reject" | "skip",
      submit: ApprovalApi["rejectCandidate"] | ApprovalApi["skipCandidate"],
    ) => {
      const mutationKey = buildMutationKey(action, candidate);
      const requestId = claimRequestId(mutationKey);
      setSubmitting(true);

      try {
        const result = await submit({ candidateId: candidate.id, requestId });
        releaseRequestId(mutationKey);
        removeCandidate(candidate.id);
        setLastActionId(result.actionId);
        return result;
      } finally {
        setSubmitting(false);
      }
    },
    [claimRequestId, releaseRequestId, removeCandidate],
  );

  const approve = useCallback(
    (candidate: ApprovalCandidate, options?: UpdateExistingOptions) =>
      submitApproval(candidate, "approve", options),
    [submitApproval],
  );

  const keepQuestionOnly = useCallback(
    (candidate: ApprovalCandidate, options?: UpdateExistingOptions) =>
      submitApproval(candidate, "question_only", options),
    [submitApproval],
  );

  const reject = useCallback(
    (candidate: ApprovalCandidate) =>
      submitCandidateMutation(candidate, "reject", api.rejectCandidate),
    [api.rejectCandidate, submitCandidateMutation],
  );

  const skipProbe = useCallback(
    async (candidate: ApprovalCandidate) => {
      const mutationKey = buildMutationKey("skip", candidate);
      const requestId = claimRequestId(mutationKey);
      setSubmitting(true);

      try {
        const result = await api.skipCandidate({ candidateId: candidate.id, requestId });
        releaseRequestId(mutationKey);
        setCandidates((current) => {
          const index = current.findIndex((item) => item.id === candidate.id);
          if (index < 0) {
            return current;
          }

          const next = current.slice();
          const [item] = next.splice(index, 1);
          if (!item) {
            return current;
          }
          next.push(item);
          return next;
        });
        setLastActionId(null);
        return result;
      } finally {
        setSubmitting(false);
      }
    },
    [api, claimRequestId, releaseRequestId],
  );

  const undo = useCallback(async () => {
    if (!lastActionId) {
      return null;
    }

    setSubmitting(true);
    try {
      const result = await api.undo({ actionId: lastActionId });
      if (result.restoredCandidate?.kind === kind) {
        reopenCandidate(result.restoredCandidate);
      }
      setLastActionId(null);
      return result;
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? error.code : null;
      if (code === "UNDO_EXPIRED" || code === "ANCHOR_NOT_FOUND") {
        setLastActionId(null);
      }
      throw error;
    } finally {
      setSubmitting(false);
    }
  }, [api, kind, lastActionId, reopenCandidate]);

  return useMemo(
    () => ({
      candidates,
      total,
      loading,
      submitting,
      lastActionId,
      reload: load,
      approve,
      keepQuestionOnly,
      reject,
      skipProbe,
      undo,
    }),
    [
      approve,
      candidates,
      keepQuestionOnly,
      lastActionId,
      load,
      loading,
      reject,
      skipProbe,
      submitting,
      total,
      undo,
    ],
  );
}
