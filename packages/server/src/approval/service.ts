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
import { getSoulAssetKind, normalizeAnswer, normalizeQuestion } from "./normalize.js";
import { buildSourceContext } from "./source-context.js";

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
    rollbackPayload: Record<string, unknown>;
    createdAt: number;
  }) {
    input.conn.drizzle
      .insert(approvalLastActions)
      .values({
        ownerKey: input.ownerKey,
        actionId: params.actionId,
        candidateSnapshot: JSON.stringify(params.candidateSnapshot),
        rollbackPayload: JSON.stringify(params.rollbackPayload),
        createdAt: params.createdAt,
      })
      .onConflictDoUpdate({
        target: approvalLastActions.ownerKey,
        set: {
          actionId: params.actionId,
          candidateSnapshot: JSON.stringify(params.candidateSnapshot),
          rollbackPayload: JSON.stringify(params.rollbackPayload),
          createdAt: params.createdAt,
        },
      })
      .run();
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
  }): AnchorRow {
    const answer = params.action === "question_only" ? null : params.candidate.answer;
    return {
      id: params.id,
      question: params.candidate.question,
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

  return {
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

      return mapCandidate(getCandidateOrThrow(id));
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
      requestId: string;
    }): Promise<ApprovalResult> {
      const existingRequest = getRecordedRequest(inputParams.candidateId, inputParams.requestId);
      if (existingRequest) {
        return JSON.parse(existingRequest.responsePayload) as ApprovalResult;
      }

      const candidate = getCandidateOrThrow(inputParams.candidateId);
      const now = Date.now();
      const actionId = crypto.randomUUID();

      if (inputParams.mode === "update_existing") {
        if (inputParams.targetUpdatedAt == null || !inputParams.targetAssetId) {
          throw new Error("targetUpdatedAt is required for update_existing");
        }

        const existing = getAnchorOrThrow(inputParams.targetAssetId);
        if (existing.updatedAt !== inputParams.targetUpdatedAt) {
          throw new Error("Target asset is stale; updatedAt mismatch");
        }
      }

      const assetForWrite =
        inputParams.action === "reject"
          ? null
          : inputParams.mode === "create_new"
            ? buildCandidateAssetValues({
                candidate,
                action: inputParams.action,
                now,
                id: crypto.randomUUID(),
              })
            : (() => {
                const existing = getAnchorOrThrow(inputParams.targetAssetId!);
                return {
                  ...existing,
                  question: candidate.question,
                  answer: inputParams.action === "question_only" ? null : candidate.answer,
                  source: candidate.source,
                  updatedAt: now,
                } satisfies AnchorRow;
              })();
      const embedding = assetForWrite ? await buildAnchorEmbedding(assetForWrite) : null;

      try {
        return input.conn.raw.transaction(() => {
          const recorded = getRecordedRequest(inputParams.candidateId, inputParams.requestId);
          if (recorded) {
            return JSON.parse(recorded.responsePayload) as ApprovalResult;
          }

          const candidateInsideTxn = getCandidateOrThrow(inputParams.candidateId);

          if (inputParams.action === "reject") {
            input.conn.drizzle
              .delete(soulCandidateQueue)
              .where(eq(soulCandidateQueue.id, candidateInsideTxn.id))
              .run();

            const responsePayload: ApprovalResult = { actionId, asset: null };
            writeLastAction({
              actionId,
              candidateSnapshot: candidateInsideTxn,
              rollbackPayload: { type: "delete_candidate" },
              createdAt: now,
            });
            recordRequest({
              targetId: candidateInsideTxn.id,
              requestId: inputParams.requestId,
              action: inputParams.action,
              responsePayload,
              createdAt: now,
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
              rollbackPayload: { type: "create_asset", assetAfter: asset },
              createdAt: now,
            });
            recordRequest({
              targetId: candidateInsideTxn.id,
              requestId: inputParams.requestId,
              action: inputParams.action,
              responsePayload,
              createdAt: now,
            });

            return responsePayload;
          }

          const existing = getAnchorOrThrow(inputParams.targetAssetId!);
          if (existing.updatedAt !== inputParams.targetUpdatedAt) {
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
            rollbackPayload: { type: "restore_asset", before: existing, after: updated },
            createdAt: now,
          });
          recordRequest({
            targetId: candidateInsideTxn.id,
            requestId: inputParams.requestId,
            action: inputParams.action,
            responsePayload,
            createdAt: now,
          });

          return responsePayload;
        })();
      } catch (error) {
        if (isSqliteUniqueConstraint(error)) {
          return getRecordedRequestOrThrow<ApprovalResult>(
            inputParams.candidateId,
            inputParams.requestId,
          );
        }
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
            return JSON.parse(recorded.responsePayload) as ApprovalMutationResult;
          }

          if (!inputParams.assetId) {
            input.conn.drizzle.insert(soulAnchors).values(assetForWrite).run();
            upsertAnchorEmbeddingInTxn(assetForWrite.id, embedding);
            const responsePayload: ApprovalMutationResult = { actionId, asset: assetForWrite };
            writeLastAction({
              actionId,
              candidateSnapshot: null,
              rollbackPayload: { type: "create_asset", assetAfter: assetForWrite },
              createdAt: now,
            });
            recordRequest({
              targetId,
              requestId: inputParams.requestId,
              action: "micro_edit",
              responsePayload,
              createdAt: now,
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
            rollbackPayload: { type: "restore_asset", before: existing, after: assetForWrite },
            createdAt: now,
          });
          recordRequest({
            targetId,
            requestId: inputParams.requestId,
            action: "micro_edit",
            responsePayload,
            createdAt: now,
          });

          return responsePayload;
        })();
      } catch (error) {
        if (isSqliteUniqueConstraint(error)) {
          return getRecordedRequestOrThrow<ApprovalMutationResult>(targetId, inputParams.requestId);
        }
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
        return JSON.parse(existingRequest.responsePayload) as ApprovalMutationResult;
      }

      const now = Date.now();
      const actionId = crypto.randomUUID();

      try {
        return await withImmediateTransaction(input.conn, async () => {
          const recorded = getRecordedRequest(targetId, inputParams.requestId);
          if (recorded) {
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
            rollbackPayload: { type: "restore_asset", before: current, after: updated },
            createdAt: now,
          });
          recordRequest({
            targetId,
            requestId: inputParams.requestId,
            action: "deny",
            responsePayload,
            createdAt: now,
          });

          return responsePayload;
        });
      } catch (error) {
        if (isSqliteUniqueConstraint(error)) {
          return getRecordedRequestOrThrow<ApprovalMutationResult>(targetId, inputParams.requestId);
        }
        throw error;
      }
    },

    deleteAnchorEmbedding(assetId: string) {
      deleteEmbedding(input.conn.raw, "soul_anchors_vec", assetId);
    },

    async undoLastAction(inputParams: { actionId: string }) {
      const lastAction = input.conn.drizzle
        .select()
        .from(approvalLastActions)
        .where(eq(approvalLastActions.ownerKey, input.ownerKey))
        .get();

      if (!lastAction || lastAction.actionId !== inputParams.actionId) {
        throw new Error("Undo target not found");
      }

      const rollbackPayload = JSON.parse(lastAction.rollbackPayload) as
        | { type: "create_asset"; assetAfter: AnchorRow }
        | { type: "restore_asset"; before: AnchorRow; after: AnchorRow }
        | { type: "delete_candidate" };
      const candidateSnapshot = JSON.parse(lastAction.candidateSnapshot) as CandidateRow | null;
      const rollbackEmbedding =
        rollbackPayload.type === "restore_asset"
          ? await buildAnchorEmbedding(mapAnchor(rollbackPayload.before))
          : null;

      const restoredCandidate = input.conn.raw.transaction(() => {
        if (rollbackPayload.type === "create_asset") {
          const current = getAnchorOrThrow(rollbackPayload.assetAfter.id);
          if (current.updatedAt !== rollbackPayload.assetAfter.updatedAt) {
            throw new Error("Undo conflict: asset changed after the last action");
          }
          input.conn.drizzle.delete(soulAnchors).where(eq(soulAnchors.id, current.id)).run();
          deleteAnchorEmbeddingInTxn(rollbackPayload.assetAfter.id);
        } else if (rollbackPayload.type === "restore_asset") {
          const current = getAnchorOrThrow(rollbackPayload.after.id);
          if (current.updatedAt !== rollbackPayload.after.updatedAt) {
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

        input.conn.drizzle
          .delete(approvalLastActions)
          .where(eq(approvalLastActions.ownerKey, input.ownerKey))
          .run();

        return candidateSnapshot ? mapCandidate(candidateSnapshot) : null;
      })();

      return {
        actionId: inputParams.actionId,
        restoredCandidate,
      };
    },
  };
}
