import { and, desc, eq } from "drizzle-orm";
import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { EmbeddingClient } from "../embedding/client.js";
import { deleteEmbedding, upsertEmbedding } from "../embedding/index.js";
import {
  approvalLastActions,
  approvalRequests,
  soulAnchors,
  soulCandidateQueue,
} from "../db/schema.js";
import type {
  ApprovalAction,
  ApprovalCandidate,
  ApprovalCandidateCreateInput,
  ApprovalWriteMode,
  PaginatedData,
  SoulAnchor,
  SoulAnchorSource,
  SoulAssetKind,
} from "../types.js";
import { logger } from "../logger.js";
import { buildApprovalAlert } from "./alerts.js";
import { getSoulAssetKind, normalizeAnswer, normalizeQuestion } from "./normalize.js";
import { buildSourceContext } from "./source-context.js";

const APPROVAL_GATEWAY = "controlled_write_service";
export const APPROVAL_UNDO_TTL_MS = 5 * 60 * 1000;
const log = logger.child({ module: "approval-service", gateway: APPROVAL_GATEWAY });

interface ApprovalConnection {
  raw: Database.Database;
  drizzle: BetterSQLite3Database;
}

interface CreateApprovalServiceInput {
  ownerKey: string;
  conn: ApprovalConnection;
  embeddingClient?: EmbeddingClient | null;
}

interface ApprovalResult {
  actionId: string;
  asset: SoulAnchor | null;
}

interface ApprovalMutationResult {
  actionId: string;
  asset: SoulAnchor;
}

interface UndoState {
  actionId: string;
  expiresAt: number;
}

type FormalAssetActionType = "approval" | "update_existing" | "micro_edit" | "deny" | "undo";

interface RollbackMetadata {
  assetId: string | null;
  candidateId: string | null;
  requestId: string | null;
  actionType: Exclude<FormalAssetActionType, "undo">;
}

type RollbackPayload =
  | { type: "create_asset"; assetAfter: AnchorRow; meta: RollbackMetadata }
  | { type: "restore_asset"; before: AnchorRow; after: AnchorRow; meta: RollbackMetadata }
  | { type: "delete_candidate"; meta: { candidateId: string; requestId: string | null } };

type CandidateRow = typeof soulCandidateQueue.$inferSelect;
type AnchorRow = typeof soulAnchors.$inferSelect;

function isSqliteUniqueConstraint(error: unknown) {
  return error instanceof Error && /unique constraint/i.test(error.message);
}

function mapCandidate(row: CandidateRow): ApprovalCandidate {
  return {
    id: row.id,
    ownerKey: row.ownerKey,
    question: row.question,
    answer: row.answer,
    source: row.source,
    sourceRef: row.sourceRef,
    sourceSnapshot: row.sourceSnapshot,
    createdAt: row.createdAt,
    kind: getSoulAssetKind({ answer: row.answer }),
  };
}

function normalizeLimit(limit: number) {
  return Math.max(0, Math.floor(limit));
}

function normalizeOffset(offset: number) {
  return Math.max(0, Math.floor(offset));
}

function mapAnchor(row: AnchorRow): SoulAnchor {
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function withImmediateTransaction<T>(conn: ApprovalConnection, action: () => Promise<T> | T) {
  conn.raw.exec("BEGIN IMMEDIATE");

  try {
    const result = await action();
    conn.raw.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      conn.raw.exec("ROLLBACK");
    } catch {
      // ignore rollback failures after a failed write
    }

    throw error;
  }
}

export function createApprovalService(input: CreateApprovalServiceInput) {
  async function buildAnchorEmbedding(anchor: Pick<SoulAnchor, "question" | "answer">) {
    if (!input.embeddingClient) {
      return null;
    }

    const [embedding] = await input.embeddingClient.embed([
      `${anchor.question}\n${anchor.answer ?? ""}`,
    ]);
    return embedding;
  }

  function upsertAnchorEmbeddingInTxn(anchorId: string, embedding: number[] | null) {
    if (!embedding) {
      return;
    }
    upsertEmbedding(input.conn.raw, "soul_anchors_vec", anchorId, embedding);
  }

  function deleteAnchorEmbeddingInTxn(anchorId: string) {
    if (!input.embeddingClient) {
      return;
    }
    deleteEmbedding(input.conn.raw, "soul_anchors_vec", anchorId);
  }

  function writeLastAction(params: {
    actionId: string;
    candidateSnapshot: CandidateRow | null;
    rollbackPayload: RollbackPayload;
    createdAt: number;
  }) {
    const expiresAt = params.createdAt + APPROVAL_UNDO_TTL_MS;
    input.conn.drizzle
      .insert(approvalLastActions)
      .values({
        ownerKey: input.ownerKey,
        actionId: params.actionId,
        candidateSnapshot: JSON.stringify(params.candidateSnapshot),
        rollbackPayload: JSON.stringify(params.rollbackPayload),
        createdAt: params.createdAt,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: approvalLastActions.ownerKey,
        set: {
          actionId: params.actionId,
          candidateSnapshot: JSON.stringify(params.candidateSnapshot),
          rollbackPayload: JSON.stringify(params.rollbackPayload),
          createdAt: params.createdAt,
          expiresAt,
        },
      })
      .run();
  }

  function clearLastAction() {
    input.conn.drizzle
      .delete(approvalLastActions)
      .where(eq(approvalLastActions.ownerKey, input.ownerKey))
      .run();
  }

  function getLastActionRow() {
    return input.conn.drizzle
      .select()
      .from(approvalLastActions)
      .where(eq(approvalLastActions.ownerKey, input.ownerKey))
      .get();
  }

  function getUndoState(): UndoState | null {
    const lastAction = getLastActionRow();
    if (!lastAction) {
      return null;
    }

    if (lastAction.expiresAt <= Date.now()) {
      clearLastAction();
      return null;
    }

    return {
      actionId: lastAction.actionId,
      expiresAt: lastAction.expiresAt,
    };
  }

  function getCandidateOrThrow(candidateId: string): CandidateRow {
    const candidate = input.conn.drizzle
      .select()
      .from(soulCandidateQueue)
      .where(eq(soulCandidateQueue.id, candidateId))
      .get();

    if (!candidate) {
      throw new Error("Approval candidate not found");
    }

    return candidate;
  }

  function getAnchorOrThrow(assetId: string): AnchorRow {
    const asset = input.conn.drizzle
      .select()
      .from(soulAnchors)
      .where(eq(soulAnchors.id, assetId))
      .get();

    if (!asset) {
      throw new Error("Soul anchor not found");
    }

    return asset;
  }

  function buildCandidateAssetValues(params: {
    candidate: CandidateRow;
    action: ApprovalAction;
    now: number;
    id: string;
    question: string;
    answer: string | null;
  }): AnchorRow {
    const answer = params.action === "question_only" ? null : params.answer;
    return {
      id: params.id,
      question: params.question,
      answer,
      source: params.candidate.source,
      createdAt: params.now,
      updatedAt: params.now,
    };
  }

  function getRecordedRequest(targetId: string, requestId: string) {
    return input.conn.drizzle
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.ownerKey, input.ownerKey),
          eq(approvalRequests.candidateId, targetId),
          eq(approvalRequests.requestId, requestId),
        ),
      )
      .get();
  }

  function getRecordedRequestOrThrow<T>(targetId: string, requestId: string): T {
    const recorded = getRecordedRequest(targetId, requestId);
    if (!recorded) {
      throw new Error("Idempotent approval request result not found");
    }

    return JSON.parse(recorded.responsePayload) as T;
  }

  function recordRequest(params: {
    targetId: string;
    requestId: string;
    action: string;
    responsePayload: unknown;
    createdAt: number;
  }) {
    input.conn.drizzle
      .insert(approvalRequests)
      .values({
        id: crypto.randomUUID(),
        ownerKey: input.ownerKey,
        candidateId: params.targetId,
        requestId: params.requestId,
        action: params.action,
        responsePayload: JSON.stringify(params.responsePayload),
        createdAt: params.createdAt,
      })
      .run();
  }

  function emitEvent(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>,
  ) {
    const payload = { event, ownerKey: input.ownerKey, gateway: APPROVAL_GATEWAY, ...fields };
    log[level](payload, event);

    const alert = buildApprovalAlert({
      event,
      ownerKey: input.ownerKey,
      requestId: (fields.requestId as string | null | undefined) ?? null,
      actionId: (fields.actionId as string | null | undefined) ?? null,
      candidateId: (fields.candidateId as string | null | undefined) ?? null,
      assetId: (fields.assetId as string | null | undefined) ?? null,
      gateway: (fields.gateway as string | null | undefined) ?? APPROVAL_GATEWAY,
      actionType: (fields.actionType as string | null | undefined) ?? null,
      routeOrModule: (fields.routeOrModule as string | null | undefined) ?? null,
      attemptedAction: (fields.attemptedAction as string | null | undefined) ?? null,
    });

    if (alert) {
      logger.error(alert, alert.alertType);
    }
  }

  function emitFormalAssetWritten(params: {
    assetId: string;
    actionId: string;
    actionType: FormalAssetActionType;
    candidateId: string | null;
    requestId: string | null;
    undoneActionId?: string;
  }) {
    emitEvent("info", "formal_asset_written", {
      assetId: params.assetId,
      actionId: params.actionId,
      ownerKey: input.ownerKey,
      gateway: APPROVAL_GATEWAY,
      actionType: params.actionType,
      candidateId: params.candidateId,
      requestId: params.requestId,
      undoneActionId: params.undoneActionId,
    });
  }

  function emitIdempotencyHit(targetId: string, requestId: string) {
    emitEvent("info", "approval_idempotency_hit", {
      targetId,
      requestId,
      candidateId: targetId.startsWith("asset:") ? null : targetId,
    });
  }

  function getAnyRecordedRequest(targetId: string) {
    return input.conn.drizzle
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.ownerKey, input.ownerKey),
          eq(approvalRequests.candidateId, targetId),
        ),
      )
      .get();
  }

  function getCandidateForMutation(candidateId: string, requestId: string): CandidateRow {
    const candidate = input.conn.drizzle
      .select()
      .from(soulCandidateQueue)
      .where(eq(soulCandidateQueue.id, candidateId))
      .get();

    if (candidate) {
      return candidate;
    }

    if (getAnyRecordedRequest(candidateId)) {
      emitEvent("warn", "approval_rejected_already_processed", {
        candidateId,
        requestId,
      });
    }

    throw new Error("Approval candidate not found");
  }

  return {
    getUndoState,

    createCandidate(candidate: ApprovalCandidateCreateInput): ApprovalCandidate {
      const now = Date.now();
      const id = crypto.randomUUID();
      const sourceContext = buildSourceContext(candidate);

      input.conn.drizzle
        .insert(soulCandidateQueue)
        .values({
          id,
          ownerKey: input.ownerKey,
          question: normalizeQuestion(candidate.question),
          answer: normalizeAnswer(candidate.answer),
          source: sourceContext.source,
          sourceRef: sourceContext.sourceRef,
          sourceSnapshot: sourceContext.sourceSnapshot,
          createdAt: now,
        })
        .run();

      const created = mapCandidate(getCandidateOrThrow(id));
      emitEvent("info", "candidate_created", {
        candidateId: created.id,
        source: created.source,
      });
      return created;
    },

    listCandidates(inputParams: {
      kind: SoulAssetKind;
      limit: number;
      offset: number;
    }): PaginatedData<ApprovalCandidate> {
      const limit = normalizeLimit(inputParams.limit);
      const offset = normalizeOffset(inputParams.offset);
      const filtered = input.conn.drizzle
        .select()
        .from(soulCandidateQueue)
        .orderBy(desc(soulCandidateQueue.createdAt))
        .all()
        .map(mapCandidate)
        .filter((candidate) => candidate.kind === inputParams.kind);

      return {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        limit,
        offset,
      };
    },

    async approveCandidate(inputParams: {
      candidateId: string;
      action: ApprovalAction;
      mode: ApprovalWriteMode;
      targetAssetId?: string;
      targetUpdatedAt?: number;
      question?: string;
      answer?: string | null;
      requestId: string;
    }): Promise<ApprovalResult> {
      const existingRequest = getRecordedRequest(inputParams.candidateId, inputParams.requestId);
      if (existingRequest) {
        emitIdempotencyHit(inputParams.candidateId, inputParams.requestId);
        return JSON.parse(existingRequest.responsePayload) as ApprovalResult;
      }

      const candidate = getCandidateForMutation(inputParams.candidateId, inputParams.requestId);
      const now = Date.now();
      const actionId = crypto.randomUUID();
      const question = normalizeQuestion(inputParams.question ?? candidate.question);
      const answer = normalizeAnswer(inputParams.answer ?? candidate.answer);

      if (inputParams.mode === "update_existing") {
        if (inputParams.targetUpdatedAt == null || !inputParams.targetAssetId) {
          throw new Error("targetUpdatedAt is required for update_existing");
        }

        const existing = getAnchorOrThrow(inputParams.targetAssetId);
        if (existing.updatedAt !== inputParams.targetUpdatedAt) {
          emitEvent("warn", "approval_rejected_stale_target", {
            candidateId: inputParams.candidateId,
            requestId: inputParams.requestId,
            assetId: inputParams.targetAssetId,
          });
          throw new Error("Target asset is stale; updatedAt mismatch");
        }
      }

      emitEvent("info", "approval_applied", {
        candidateId: inputParams.candidateId,
        requestId: inputParams.requestId,
        actionId,
      });

      const assetForWrite =
        inputParams.action === "reject"
          ? null
          : inputParams.mode === "create_new"
            ? buildCandidateAssetValues({
                candidate,
                action: inputParams.action,
                now,
                id: crypto.randomUUID(),
                question,
                answer,
              })
            : (() => {
                const existing = getAnchorOrThrow(inputParams.targetAssetId!);
                return {
                  ...existing,
                  question,
                  answer: inputParams.action === "question_only" ? null : answer,
                  source: candidate.source,
                  updatedAt: now,
                } satisfies AnchorRow;
              })();
      const embedding = assetForWrite ? await buildAnchorEmbedding(assetForWrite) : null;

      try {
        return input.conn.raw.transaction(() => {
          const recorded = getRecordedRequest(inputParams.candidateId, inputParams.requestId);
          if (recorded) {
            emitIdempotencyHit(inputParams.candidateId, inputParams.requestId);
            return JSON.parse(recorded.responsePayload) as ApprovalResult;
          }

          const candidateInsideTxn = getCandidateForMutation(
            inputParams.candidateId,
            inputParams.requestId,
          );

          if (inputParams.action === "reject") {
            input.conn.drizzle
              .delete(soulCandidateQueue)
              .where(eq(soulCandidateQueue.id, candidateInsideTxn.id))
              .run();

            const responsePayload: ApprovalResult = { actionId, asset: null };
            writeLastAction({
              actionId,
              candidateSnapshot: candidateInsideTxn,
              rollbackPayload: {
                type: "delete_candidate",
                meta: {
                  candidateId: candidateInsideTxn.id,
                  requestId: inputParams.requestId,
                },
              },
              createdAt: now,
            });
            recordRequest({
              targetId: candidateInsideTxn.id,
              requestId: inputParams.requestId,
              action: inputParams.action,
              responsePayload,
              createdAt: now,
            });

            emitEvent("info", "candidate_deleted", {
              candidateId: candidateInsideTxn.id,
              requestId: inputParams.requestId,
              actionId,
            });

            return responsePayload;
          }

          if (inputParams.mode === "create_new") {
            const asset = assetForWrite!;
            input.conn.drizzle.insert(soulAnchors).values(asset).run();
            upsertAnchorEmbeddingInTxn(asset.id, embedding);
            input.conn.drizzle
              .delete(soulCandidateQueue)
              .where(eq(soulCandidateQueue.id, candidateInsideTxn.id))
              .run();
            const responsePayload: ApprovalResult = { actionId, asset };
            writeLastAction({
              actionId,
              candidateSnapshot: candidateInsideTxn,
              rollbackPayload: {
                type: "create_asset",
                assetAfter: asset,
                meta: {
                  assetId: asset.id,
                  candidateId: candidateInsideTxn.id,
                  requestId: inputParams.requestId,
                  actionType: "approval",
                },
              },
              createdAt: now,
            });
            recordRequest({
              targetId: candidateInsideTxn.id,
              requestId: inputParams.requestId,
              action: inputParams.action,
              responsePayload,
              createdAt: now,
            });

            emitFormalAssetWritten({
              assetId: asset.id,
              actionId,
              actionType: "approval",
              candidateId: candidateInsideTxn.id,
              requestId: inputParams.requestId,
            });
            emitEvent("info", "approval_committed", {
              candidateId: candidateInsideTxn.id,
              requestId: inputParams.requestId,
              actionId,
              assetId: asset.id,
            });
            emitEvent("info", "candidate_deleted", {
              candidateId: candidateInsideTxn.id,
              requestId: inputParams.requestId,
              actionId,
            });

            return responsePayload;
          }

          const existing = getAnchorOrThrow(inputParams.targetAssetId!);
          if (existing.updatedAt !== inputParams.targetUpdatedAt) {
            emitEvent("warn", "approval_rejected_stale_target", {
              candidateId: inputParams.candidateId,
              requestId: inputParams.requestId,
              assetId: inputParams.targetAssetId,
            });
            throw new Error("Target asset is stale; updatedAt mismatch");
          }

          const updated = assetForWrite!;
          input.conn.drizzle
            .update(soulAnchors)
            .set({
              question: updated.question,
              answer: updated.answer,
              source: updated.source,
              updatedAt: updated.updatedAt,
            })
            .where(eq(soulAnchors.id, existing.id))
            .run();
          upsertAnchorEmbeddingInTxn(updated.id, embedding);
          input.conn.drizzle
            .delete(soulCandidateQueue)
            .where(eq(soulCandidateQueue.id, candidateInsideTxn.id))
            .run();
          const responsePayload: ApprovalResult = { actionId, asset: updated };
          writeLastAction({
            actionId,
            candidateSnapshot: candidateInsideTxn,
            rollbackPayload: {
              type: "restore_asset",
              before: existing,
              after: updated,
              meta: {
                assetId: updated.id,
                candidateId: candidateInsideTxn.id,
                requestId: inputParams.requestId,
                actionType: "update_existing",
              },
            },
            createdAt: now,
          });
          recordRequest({
            targetId: candidateInsideTxn.id,
            requestId: inputParams.requestId,
            action: inputParams.action,
            responsePayload,
            createdAt: now,
          });

          emitFormalAssetWritten({
            assetId: updated.id,
            actionId,
            actionType: "update_existing",
            candidateId: candidateInsideTxn.id,
            requestId: inputParams.requestId,
          });
          emitEvent("info", "approval_committed", {
            candidateId: candidateInsideTxn.id,
            requestId: inputParams.requestId,
            actionId,
            assetId: updated.id,
          });
          emitEvent("info", "candidate_deleted", {
            candidateId: candidateInsideTxn.id,
            requestId: inputParams.requestId,
            actionId,
          });

          return responsePayload;
        })();
      } catch (error) {
        if (isSqliteUniqueConstraint(error)) {
          emitIdempotencyHit(inputParams.candidateId, inputParams.requestId);
          return getRecordedRequestOrThrow<ApprovalResult>(
            inputParams.candidateId,
            inputParams.requestId,
          );
        }
        emitEvent("error", "approval_tx_failed", {
          candidateId: inputParams.candidateId,
          requestId: inputParams.requestId,
          actionId,
          assetId: assetForWrite?.id ?? null,
          actionType:
            inputParams.action === "reject"
              ? null
              : inputParams.mode === "update_existing"
                ? "update_existing"
                : "approval",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    async skipCandidate(inputParams: {
      candidateId: string;
      requestId: string;
    }): Promise<ApprovalResult> {
      const existingRequest = getRecordedRequest(inputParams.candidateId, inputParams.requestId);
      if (existingRequest) {
        emitIdempotencyHit(inputParams.candidateId, inputParams.requestId);
        return JSON.parse(existingRequest.responsePayload) as ApprovalResult;
      }

      getCandidateForMutation(inputParams.candidateId, inputParams.requestId);
      const responsePayload: ApprovalResult = { actionId: crypto.randomUUID(), asset: null };
      const now = Date.now();

      try {
        return input.conn.raw.transaction(() => {
          const recorded = getRecordedRequest(inputParams.candidateId, inputParams.requestId);
          if (recorded) {
            emitIdempotencyHit(inputParams.candidateId, inputParams.requestId);
            return JSON.parse(recorded.responsePayload) as ApprovalResult;
          }

          getCandidateForMutation(inputParams.candidateId, inputParams.requestId);
          recordRequest({
            targetId: inputParams.candidateId,
            requestId: inputParams.requestId,
            action: "skip",
            responsePayload,
            createdAt: now,
          });

          emitEvent("info", "candidate_skipped", {
            candidateId: inputParams.candidateId,
            requestId: inputParams.requestId,
          });

          return responsePayload;
        })();
      } catch (error) {
        if (isSqliteUniqueConstraint(error)) {
          emitIdempotencyHit(inputParams.candidateId, inputParams.requestId);
          return getRecordedRequestOrThrow<ApprovalResult>(
            inputParams.candidateId,
            inputParams.requestId,
          );
        }
        emitEvent("error", "approval_tx_failed", {
          candidateId: inputParams.candidateId,
          requestId: inputParams.requestId,
          actionId: responsePayload.actionId,
          actionType: null,
          assetId: null,
        });
        throw error;
      }
    },

    async microEditAsset(inputParams: {
      assetId: string | null;
      question: string;
      answer?: string | null;
      source: SoulAnchorSource;
      requestId: string;
    }): Promise<ApprovalMutationResult> {
      const targetId = inputParams.assetId ? `asset:${inputParams.assetId}` : "asset:new";
      const existingRequest = getRecordedRequest(targetId, inputParams.requestId);
      if (existingRequest) {
        emitIdempotencyHit(targetId, inputParams.requestId);
        return JSON.parse(existingRequest.responsePayload) as ApprovalMutationResult;
      }

      const now = Date.now();
      const actionId = crypto.randomUUID();
      const normalizedQuestion = normalizeQuestion(inputParams.question);
      const normalizedAnswer = normalizeAnswer(inputParams.answer);
      const assetForWrite: AnchorRow = !inputParams.assetId
        ? {
            id: crypto.randomUUID(),
            question: normalizedQuestion,
            answer: normalizedAnswer,
            source: inputParams.source,
            createdAt: now,
            updatedAt: now,
          }
        : {
            ...getAnchorOrThrow(inputParams.assetId),
            question: normalizedQuestion,
            answer: normalizedAnswer,
            source: inputParams.source,
            updatedAt: now,
          };
      const embedding = await buildAnchorEmbedding(assetForWrite);

      try {
        return input.conn.raw.transaction(() => {
          const recorded = getRecordedRequest(targetId, inputParams.requestId);
          if (recorded) {
            emitIdempotencyHit(targetId, inputParams.requestId);
            return JSON.parse(recorded.responsePayload) as ApprovalMutationResult;
          }

          if (!inputParams.assetId) {
            input.conn.drizzle.insert(soulAnchors).values(assetForWrite).run();
            upsertAnchorEmbeddingInTxn(assetForWrite.id, embedding);
            const responsePayload: ApprovalMutationResult = { actionId, asset: assetForWrite };
            writeLastAction({
              actionId,
              candidateSnapshot: null,
              rollbackPayload: {
                type: "create_asset",
                assetAfter: assetForWrite,
                meta: {
                  assetId: assetForWrite.id,
                  candidateId: null,
                  requestId: inputParams.requestId,
                  actionType: "micro_edit",
                },
              },
              createdAt: now,
            });
            recordRequest({
              targetId,
              requestId: inputParams.requestId,
              action: "micro_edit",
              responsePayload,
              createdAt: now,
            });
            emitFormalAssetWritten({
              assetId: assetForWrite.id,
              actionId,
              actionType: "micro_edit",
              candidateId: null,
              requestId: inputParams.requestId,
            });
            return responsePayload;
          }

          const existing = getAnchorOrThrow(inputParams.assetId);
          input.conn.drizzle
            .update(soulAnchors)
            .set({
              question: assetForWrite.question,
              answer: assetForWrite.answer,
              source: assetForWrite.source,
              updatedAt: assetForWrite.updatedAt,
            })
            .where(eq(soulAnchors.id, existing.id))
            .run();
          upsertAnchorEmbeddingInTxn(assetForWrite.id, embedding);
          const responsePayload: ApprovalMutationResult = { actionId, asset: assetForWrite };
          writeLastAction({
            actionId,
            candidateSnapshot: null,
            rollbackPayload: {
              type: "restore_asset",
              before: existing,
              after: assetForWrite,
              meta: {
                assetId: assetForWrite.id,
                candidateId: null,
                requestId: inputParams.requestId,
                actionType: "micro_edit",
              },
            },
            createdAt: now,
          });
          recordRequest({
            targetId,
            requestId: inputParams.requestId,
            action: "micro_edit",
            responsePayload,
            createdAt: now,
          });

          emitFormalAssetWritten({
            assetId: assetForWrite.id,
            actionId,
            actionType: "micro_edit",
            candidateId: null,
            requestId: inputParams.requestId,
          });

          return responsePayload;
        })();
      } catch (error) {
        if (isSqliteUniqueConstraint(error)) {
          emitIdempotencyHit(targetId, inputParams.requestId);
          return getRecordedRequestOrThrow<ApprovalMutationResult>(targetId, inputParams.requestId);
        }
        emitEvent("error", "approval_tx_failed", {
          candidateId: null,
          requestId: inputParams.requestId,
          actionId,
          assetId: assetForWrite.id,
          actionType: "micro_edit",
        });
        throw error;
      }
    },

    async denyAsset(inputParams: {
      assetId: string;
      requestId: string;
    }): Promise<ApprovalMutationResult> {
      const targetId = `asset:${inputParams.assetId}`;
      const existingRequest = getRecordedRequest(targetId, inputParams.requestId);
      if (existingRequest) {
        emitIdempotencyHit(targetId, inputParams.requestId);
        return JSON.parse(existingRequest.responsePayload) as ApprovalMutationResult;
      }

      const now = Date.now();
      const actionId = crypto.randomUUID();

      try {
        return await withImmediateTransaction(input.conn, async () => {
          const recorded = getRecordedRequest(targetId, inputParams.requestId);
          if (recorded) {
            emitIdempotencyHit(targetId, inputParams.requestId);
            return JSON.parse(recorded.responsePayload) as ApprovalMutationResult;
          }

          const current = getAnchorOrThrow(inputParams.assetId);
          const updated: AnchorRow = {
            ...current,
            answer: null,
            updatedAt: now,
          };
          const embedding = await buildAnchorEmbedding(updated);

          input.conn.drizzle
            .update(soulAnchors)
            .set({
              question: updated.question,
              answer: updated.answer,
              source: updated.source,
              updatedAt: updated.updatedAt,
            })
            .where(eq(soulAnchors.id, current.id))
            .run();
          upsertAnchorEmbeddingInTxn(updated.id, embedding);
          const responsePayload: ApprovalMutationResult = { actionId, asset: updated };
          writeLastAction({
            actionId,
            candidateSnapshot: null,
            rollbackPayload: {
              type: "restore_asset",
              before: current,
              after: updated,
              meta: {
                assetId: updated.id,
                candidateId: null,
                requestId: inputParams.requestId,
                actionType: "deny",
              },
            },
            createdAt: now,
          });
          recordRequest({
            targetId,
            requestId: inputParams.requestId,
            action: "deny",
            responsePayload,
            createdAt: now,
          });

          emitFormalAssetWritten({
            assetId: updated.id,
            actionId,
            actionType: "deny",
            candidateId: null,
            requestId: inputParams.requestId,
          });

          return responsePayload;
        });
      } catch (error) {
        if (isSqliteUniqueConstraint(error)) {
          emitIdempotencyHit(targetId, inputParams.requestId);
          return getRecordedRequestOrThrow<ApprovalMutationResult>(targetId, inputParams.requestId);
        }
        emitEvent("error", "approval_tx_failed", {
          candidateId: null,
          requestId: inputParams.requestId,
          actionId,
          assetId: inputParams.assetId,
          actionType: "deny",
        });
        throw error;
      }
    },

    deleteAnchorEmbedding(assetId: string) {
      deleteEmbedding(input.conn.raw, "soul_anchors_vec", assetId);
    },

    async undoLastAction(inputParams: { actionId: string }) {
      const lastAction = getLastActionRow();

      if (lastAction && lastAction.expiresAt <= Date.now()) {
        clearLastAction();
        if (lastAction.actionId === inputParams.actionId) {
          emitEvent("warn", "undo_rejected_expired", {
            actionId: inputParams.actionId,
          });
          throw new Error("Undo target expired");
        }
      }

      if (!lastAction || lastAction.actionId !== inputParams.actionId) {
        throw new Error("Undo target not found");
      }

      const rollbackPayload = JSON.parse(lastAction.rollbackPayload) as RollbackPayload;
      const candidateSnapshot = JSON.parse(lastAction.candidateSnapshot) as CandidateRow | null;
      const rollbackEmbedding =
        rollbackPayload.type === "restore_asset"
          ? await buildAnchorEmbedding(mapAnchor(rollbackPayload.before))
          : null;
      const undoActionId = crypto.randomUUID();

      try {
        const restoredCandidate = input.conn.raw.transaction(() => {
          if (rollbackPayload.type === "create_asset") {
            const current = getAnchorOrThrow(rollbackPayload.assetAfter.id);
            if (current.updatedAt !== rollbackPayload.assetAfter.updatedAt) {
              emitEvent("warn", "undo_rejected_conflict", {
                actionId: undoActionId,
                undoneActionId: inputParams.actionId,
                assetId: rollbackPayload.assetAfter.id,
                candidateId: rollbackPayload.meta.candidateId,
              });
              throw new Error("Undo conflict: asset changed after the last action");
            }
            input.conn.drizzle.delete(soulAnchors).where(eq(soulAnchors.id, current.id)).run();
            deleteAnchorEmbeddingInTxn(rollbackPayload.assetAfter.id);
          } else if (rollbackPayload.type === "restore_asset") {
            const current = getAnchorOrThrow(rollbackPayload.after.id);
            if (current.updatedAt !== rollbackPayload.after.updatedAt) {
              emitEvent("warn", "undo_rejected_conflict", {
                actionId: undoActionId,
                undoneActionId: inputParams.actionId,
                assetId: rollbackPayload.after.id,
                candidateId: rollbackPayload.meta.candidateId,
              });
              throw new Error("Undo conflict: asset changed after the last action");
            }
            input.conn.drizzle
              .update(soulAnchors)
              .set({
                question: rollbackPayload.before.question,
                answer: rollbackPayload.before.answer,
                source: rollbackPayload.before.source,
                createdAt: rollbackPayload.before.createdAt,
                updatedAt: rollbackPayload.before.updatedAt,
              })
              .where(eq(soulAnchors.id, rollbackPayload.before.id))
              .run();
            upsertAnchorEmbeddingInTxn(rollbackPayload.before.id, rollbackEmbedding);
          }

          if (candidateSnapshot) {
            input.conn.drizzle.insert(soulCandidateQueue).values(candidateSnapshot).run();
          }

          clearLastAction();

          return candidateSnapshot ? mapCandidate(candidateSnapshot) : null;
        })();

        const rollbackMeta =
          rollbackPayload.type === "delete_candidate" ? rollbackPayload.meta : rollbackPayload.meta;
        const assetId =
          rollbackPayload.type === "delete_candidate"
            ? null
            : rollbackPayload.type === "create_asset"
              ? rollbackPayload.assetAfter.id
              : rollbackPayload.before.id;

        emitEvent("info", "undo_applied", {
          actionId: undoActionId,
          undoneActionId: inputParams.actionId,
          assetId,
          candidateId: rollbackMeta.candidateId,
        });

        if (restoredCandidate) {
          emitEvent("info", "candidate_restored", {
            actionId: undoActionId,
            candidateId: restoredCandidate.id,
          });
        }

        if (assetId) {
          emitFormalAssetWritten({
            assetId,
            actionId: undoActionId,
            actionType: "undo",
            candidateId: rollbackMeta.candidateId,
            requestId: null,
            undoneActionId: inputParams.actionId,
          });
          emitEvent("info", "approval_rolled_back", {
            actionId: undoActionId,
            assetId,
            candidateId: rollbackMeta.candidateId,
          });
        }

        return {
          actionId: undoActionId,
          restoredCandidate,
        };
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("Undo conflict"))) {
          emitEvent("error", "approval_tx_failed", {
            actionId: undoActionId,
            assetId:
              rollbackPayload.type === "delete_candidate"
                ? null
                : rollbackPayload.type === "create_asset"
                  ? rollbackPayload.assetAfter.id
                  : rollbackPayload.after.id,
            candidateId:
              rollbackPayload.type === "delete_candidate"
                ? rollbackPayload.meta.candidateId
                : rollbackPayload.meta.candidateId,
            requestId: null,
            actionType: "undo",
          });
        }
        throw error;
      }
    },
  };
}
