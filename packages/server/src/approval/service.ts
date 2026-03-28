import { desc, eq } from "drizzle-orm";
import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { EmbeddingClient } from "../embedding/client.js";
import { deleteEmbedding, upsertEmbedding } from "../embedding/index.js";
import { approvalLastActions, soulAnchors, soulCandidateQueue } from "../db/schema.js";
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
  asset: SoulAnchor;
}

interface ApprovalMutationResult {
  actionId: string;
  asset: SoulAnchor;
}

type CandidateRow = typeof soulCandidateQueue.$inferSelect;
type AnchorRow = typeof soulAnchors.$inferSelect;

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

export function createApprovalService(input: CreateApprovalServiceInput) {
  async function syncAnchorEmbedding(anchor: Pick<SoulAnchor, "id" | "question" | "answer">) {
    if (!input.embeddingClient) {
      return;
    }

    const [embedding] = await input.embeddingClient.embed([
      `${anchor.question}\n${anchor.answer ?? ""}`,
    ]);
    upsertEmbedding(input.conn.raw, "soul_anchors_vec", anchor.id, embedding);
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
      const candidate = getCandidateOrThrow(inputParams.candidateId);

      if (inputParams.action === "reject") {
        input.conn.drizzle
          .delete(soulCandidateQueue)
          .where(eq(soulCandidateQueue.id, candidate.id))
          .run();
        return Promise.reject(new Error("Reject flow is not implemented in Chunk 1"));
      }

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

      const approvedAsset = input.conn.raw.transaction(() => {
        const candidateInsideTxn = getCandidateOrThrow(inputParams.candidateId);

        if (inputParams.mode === "create_new") {
          const asset = buildCandidateAssetValues({
            candidate: candidateInsideTxn,
            action: inputParams.action,
            now,
            id: crypto.randomUUID(),
          });

          input.conn.drizzle.insert(soulAnchors).values(asset).run();
          input.conn.drizzle
            .delete(soulCandidateQueue)
            .where(eq(soulCandidateQueue.id, candidateInsideTxn.id))
            .run();
          writeLastAction({
            actionId,
            candidateSnapshot: candidateInsideTxn,
            rollbackPayload: { type: "create_asset", assetId: asset.id },
            createdAt: now,
          });

          return asset;
        }

        const existing = getAnchorOrThrow(inputParams.targetAssetId!);
        if (existing.updatedAt !== inputParams.targetUpdatedAt) {
          throw new Error("Target asset is stale; updatedAt mismatch");
        }

        const updated: AnchorRow = {
          ...existing,
          question: candidateInsideTxn.question,
          answer: inputParams.action === "question_only" ? null : candidateInsideTxn.answer,
          source: candidateInsideTxn.source,
          updatedAt: now,
        };

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
        input.conn.drizzle
          .delete(soulCandidateQueue)
          .where(eq(soulCandidateQueue.id, candidateInsideTxn.id))
          .run();
        writeLastAction({
          actionId,
          candidateSnapshot: candidateInsideTxn,
          rollbackPayload: { type: "restore_asset", before: existing },
          createdAt: now,
        });

        return updated;
      })();

      await syncAnchorEmbedding(approvedAsset);

      return {
        actionId,
        asset: approvedAsset,
      };
    },

    async microEditAsset(inputParams: {
      assetId: string | null;
      question: string;
      answer?: string | null;
      source: SoulAnchorSource;
      requestId: string;
    }): Promise<ApprovalMutationResult> {
      const now = Date.now();
      const actionId = crypto.randomUUID();
      const normalizedQuestion = normalizeQuestion(inputParams.question);
      const normalizedAnswer = normalizeAnswer(inputParams.answer);

      const asset = input.conn.raw.transaction(() => {
        if (!inputParams.assetId) {
          const created: AnchorRow = {
            id: crypto.randomUUID(),
            question: normalizedQuestion,
            answer: normalizedAnswer,
            source: inputParams.source,
            createdAt: now,
            updatedAt: now,
          };

          input.conn.drizzle.insert(soulAnchors).values(created).run();
          writeLastAction({
            actionId,
            candidateSnapshot: null,
            rollbackPayload: { type: "create_asset", assetId: created.id },
            createdAt: now,
          });
          return created;
        }

        const existing = getAnchorOrThrow(inputParams.assetId);
        const updated: AnchorRow = {
          ...existing,
          question: normalizedQuestion,
          answer: normalizedAnswer,
          source: inputParams.source,
          updatedAt: now,
        };

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
        writeLastAction({
          actionId,
          candidateSnapshot: null,
          rollbackPayload: { type: "restore_asset", before: existing },
          createdAt: now,
        });

        return updated;
      })();

      await syncAnchorEmbedding(asset);

      return { actionId, asset };
    },

    async denyAsset(inputParams: {
      assetId: string;
      requestId: string;
    }): Promise<ApprovalMutationResult> {
      const existing = getAnchorOrThrow(inputParams.assetId);
      return this.microEditAsset({
        assetId: existing.id,
        question: existing.question,
        answer: null,
        source: existing.source,
        requestId: inputParams.requestId,
      });
    },

    deleteAnchorEmbedding(assetId: string) {
      deleteEmbedding(input.conn.raw, "soul_anchors_vec", assetId);
    },
  };
}
