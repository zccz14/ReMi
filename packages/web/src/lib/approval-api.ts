import type { ApiClient } from "./api-client";

export type ApprovalKind = "anchor" | "probe";
export type ApprovalSource = "interview" | "manual" | "reading";
export type ApprovalAction = "approve" | "question_only";
export type ApprovalWriteMode = "create_new" | "update_existing";

export interface ApprovalCandidate {
  id: string;
  ownerKey: string;
  question: string;
  answer: string | null;
  source: ApprovalSource;
  sourceRef: string | null;
  sourceSnapshot: string | Record<string, unknown> | null;
  createdAt: number;
  kind: ApprovalKind;
}

export interface ApprovalAsset {
  id: string;
  question: string;
  answer: string | null;
  source: ApprovalSource;
  createdAt: number;
  updatedAt: number;
}

export interface PaginatedApprovalCandidates {
  items: ApprovalCandidate[];
  total: number;
  limit: number;
  offset: number;
}

export interface ApprovalResult {
  actionId: string;
  asset: ApprovalAsset | null;
}

export interface UndoResult {
  actionId: string;
  restoredCandidate: ApprovalCandidate | null;
}

export interface UndoState {
  actionId: string;
  expiresAt: number;
}

export interface ApproveCandidateInput {
  candidateId: string;
  requestId: string;
  action?: ApprovalAction;
  mode?: ApprovalWriteMode;
  targetAssetId?: string;
  targetUpdatedAt?: number;
  question?: string;
  answer?: string | null;
}

export interface CandidateMutationInput {
  candidateId: string;
  requestId: string;
}

export interface ApprovalApi {
  listCandidates(kind: ApprovalKind): Promise<PaginatedApprovalCandidates>;
  approveCandidate(input: ApproveCandidateInput): Promise<ApprovalResult>;
  rejectCandidate(input: CandidateMutationInput): Promise<ApprovalResult>;
  skipCandidate(input: CandidateMutationInput): Promise<ApprovalResult>;
  getUndoState(): Promise<UndoState | null>;
  undo(input: { actionId: string }): Promise<UndoResult>;
}

function parseSourceSnapshot(snapshot: unknown) {
  if (typeof snapshot !== "string") {
    return snapshot == null ? null : (snapshot as string | Record<string, unknown>);
  }

  try {
    return JSON.parse(snapshot) as Record<string, unknown>;
  } catch {
    return snapshot;
  }
}

function mapCandidate(candidate: ApprovalCandidate): ApprovalCandidate {
  return {
    ...candidate,
    sourceSnapshot: parseSourceSnapshot(candidate.sourceSnapshot),
  };
}

export function createApprovalApi(apiClient: ApiClient): ApprovalApi {
  return {
    async listCandidates(kind) {
      const path = apiClient.ownerPath(`/approval/candidates?kind=${kind}`);
      const response = await apiClient.get<{ data: PaginatedApprovalCandidates }>(path);
      return {
        ...response.data,
        items: response.data.items.map(mapCandidate),
      };
    },
    async approveCandidate(input) {
      const { candidateId, ...body } = input;
      const response = await apiClient.post<{ data: ApprovalResult }>(
        apiClient.ownerPath(`/approval/candidates/${candidateId}/approve`),
        {
          requestId: body.requestId,
          action: body.action ?? "approve",
          mode: body.mode ?? "create_new",
          targetAssetId: body.targetAssetId,
          targetUpdatedAt: body.targetUpdatedAt,
          question: body.question,
          answer: body.answer,
        },
      );
      return response.data;
    },
    async rejectCandidate(input) {
      const response = await apiClient.post<{ data: ApprovalResult }>(
        apiClient.ownerPath(`/approval/candidates/${input.candidateId}/reject`),
        { requestId: input.requestId },
      );
      return response.data;
    },
    async skipCandidate(input) {
      const response = await apiClient.post<{ data: ApprovalResult }>(
        apiClient.ownerPath(`/approval/candidates/${input.candidateId}/skip`),
        { requestId: input.requestId },
      );
      return response.data;
    },
    async getUndoState() {
      const response = await apiClient.get<{ data: UndoState | null }>(
        apiClient.ownerPath("/approval/undo"),
      );
      return response.data;
    },
    async undo(input) {
      const response = await apiClient.post<{ data: UndoResult }>(
        apiClient.ownerPath("/approval/undo"),
        input,
      );
      return response.data;
    },
  };
}
