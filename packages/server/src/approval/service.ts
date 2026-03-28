import { desc, eq, sql } from "drizzle-orm";
import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { normalizeAnswer, normalizeQuestion, getSoulAssetKind } from "./normalize.js";
import { buildSourceContext } from "./source-context.js";
import { soulCandidateQueue } from "../db/schema.js";
import type {
  ApprovalCandidate,
  ApprovalCandidateCreateInput,
  PaginatedData,
  SoulAssetKind,
} from "../types.js";

interface ApprovalConnection {
  raw: Database.Database;
  drizzle: BetterSQLite3Database;
}

interface CreateApprovalServiceInput {
  ownerKey: string;
  conn: ApprovalConnection;
}

function mapCandidate(row: typeof soulCandidateQueue.$inferSelect): ApprovalCandidate {
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

export function createApprovalService(input: CreateApprovalServiceInput) {
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

      const created = input.conn.drizzle
        .select()
        .from(soulCandidateQueue)
        .where(eq(soulCandidateQueue.id, id))
        .get();

      if (!created) {
        throw new Error("Failed to create approval candidate");
      }

      return mapCandidate(created);
    },

    listCandidates(inputParams: {
      kind: SoulAssetKind;
      limit: number;
      offset: number;
    }): PaginatedData<ApprovalCandidate> {
      const rows = input.conn.drizzle
        .select()
        .from(soulCandidateQueue)
        .orderBy(desc(soulCandidateQueue.createdAt))
        .limit(inputParams.limit)
        .offset(inputParams.offset)
        .all()
        .map(mapCandidate)
        .filter((candidate) => candidate.kind === inputParams.kind);

      const [{ count }] = input.conn.drizzle
        .select({ count: sql<number>`count(*)` })
        .from(soulCandidateQueue)
        .all();

      return {
        items: rows,
        total: count,
        limit: inputParams.limit,
        offset: inputParams.offset,
      };
    },
  };
}
