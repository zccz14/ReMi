import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { createApprovalService } from "../approval/service.js";
import { approvalRequests } from "../db/schema.js";
import type { ConnectionManager } from "../db/connection.js";
import type { EmbeddingClient } from "../embedding/client.js";
import type { Role } from "../middleware/role.js";

declare module "hono" {
  interface ContextVariableMap {
    signerPubKey: string;
    role: Role;
    connMgr: ConnectionManager;
    embeddingClient: EmbeddingClient | null;
  }
}

const createCandidateSchema = z.object({
  question: z.string().min(1),
  answer: z.string().nullable().optional(),
  source: z.enum(["interview", "manual", "reading"]),
  sourceRef: z.string().nullable().optional(),
  sourceSnapshot: z.union([z.string(), z.record(z.string(), z.unknown()), z.null()]).optional(),
});

const listCandidatesQuerySchema = z.object({
  kind: z.enum(["anchor", "probe"]).default("anchor"),
  limit: z.coerce.number().int().nonnegative().default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const requestIdSchema = z.object({
  requestId: z.string().trim().min(1),
});

const approveCandidateSchema = requestIdSchema.extend({
  action: z.enum(["approve", "question_only"]).optional(),
  mode: z.enum(["create_new", "update_existing"]).default("create_new"),
  targetAssetId: z.string().optional(),
  targetUpdatedAt: z.number().int().optional(),
});

const undoSchema = z.object({
  actionId: z.string().trim().min(1),
});

const microEditSchema = requestIdSchema.extend({
  question: z.string().min(1),
  answer: z.string().nullable().optional(),
  source: z.enum(["interview", "manual", "reading"]),
});

function requireOwner(c: Context): Response | null {
  if (c.get("role") !== "owner") {
    return c.json({ error: "FORBIDDEN", message: "Owner access required" }, 403);
  }

  return null;
}

function validationError(c: Context, message: string) {
  return c.json({ error: "VALIDATION_ERROR", message }, 422);
}

function missingRequestId(c: Context) {
  return c.json({ error: "VALIDATION_ERROR", message: "requestId is required" }, 400);
}

function getOwnerConnection(c: Context) {
  const ownerKey = c.req.param("pubKey") ?? "";
  const conn = c.get("connMgr").getConnection(ownerKey);
  return { ownerKey, conn };
}

export function getApprovalServiceFromContext(
  c: Context,
): ReturnType<typeof createApprovalService> {
  const { ownerKey, conn } = getOwnerConnection(c);
  return createApprovalService({
    ownerKey,
    conn,
    embeddingClient: c.get("embeddingClient") ?? null,
  });
}

async function isProcessedCandidate(c: Context, candidateId: string) {
  const { ownerKey, conn } = getOwnerConnection(c);
  const request = conn.drizzle
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(eq(approvalRequests.ownerKey, ownerKey), eq(approvalRequests.candidateId, candidateId)),
    )
    .get();
  return Boolean(request);
}

export async function mapApprovalError(c: Context, error: unknown, candidateId?: string) {
  const message = error instanceof Error ? error.message : "Unknown error";

  if (message.includes("Approval candidate not found")) {
    const processed = candidateId ? await isProcessedCandidate(c, candidateId) : false;
    return c.json(
      {
        error: processed ? "CANDIDATE_ALREADY_PROCESSED" : "CANDIDATE_NOT_FOUND",
        message,
      },
      processed ? 409 : 404,
    );
  }

  if (message.includes("Soul anchor not found") || message.includes("Undo target not found")) {
    return c.json({ error: "ANCHOR_NOT_FOUND", message }, 404);
  }

  if (message.includes("updatedAt mismatch") || message.includes("stale")) {
    return c.json({ error: "STALE_TARGET", message }, 409);
  }

  if (message.includes("Undo conflict")) {
    return c.json({ error: "UNDO_CONFLICT", message }, 409);
  }

  if (message.includes("question") || message.includes("targetUpdatedAt is required")) {
    return validationError(c, message);
  }

  return c.json({ error: "INTERNAL_ERROR", message }, 500);
}

export const approvalRoutes = new Hono();

approvalRoutes.post(
  "/:pubKey/approval/candidates",
  zValidator("json", createCandidateSchema, (result, c) => {
    if (!result.success) {
      return validationError(c, result.error.message);
    }
  }),
  (c) => {
    const forbidden = requireOwner(c);
    if (forbidden) return forbidden;

    const service = getApprovalServiceFromContext(c);
    const candidate = service.createCandidate(c.req.valid("json"));
    return c.json({ data: candidate }, 201);
  },
);

approvalRoutes.get(
  "/:pubKey/approval/candidates",
  zValidator("query", listCandidatesQuerySchema, (result, c) => {
    if (!result.success) {
      return validationError(c, result.error.message);
    }
  }),
  (c) => {
    const forbidden = requireOwner(c);
    if (forbidden) return forbidden;

    const service = getApprovalServiceFromContext(c);
    const query = c.req.valid("query");
    const data = service.listCandidates({
      kind: query.kind,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json({ data });
  },
);

approvalRoutes.post(
  "/:pubKey/approval/candidates/:id/approve",
  zValidator("json", approveCandidateSchema.partial(), () => undefined),
  async (c) => {
    const forbidden = requireOwner(c);
    if (forbidden) return forbidden;

    const body = c.req.valid("json");
    if (!body.requestId?.trim()) {
      return missingRequestId(c);
    }

    try {
      const service = getApprovalServiceFromContext(c);
      const data = await service.approveCandidate({
        candidateId: c.req.param("id"),
        action: body.action ?? "approve",
        mode: body.mode ?? "create_new",
        targetAssetId: body.targetAssetId,
        targetUpdatedAt: body.targetUpdatedAt,
        requestId: body.requestId,
      });
      return c.json({ data });
    } catch (error) {
      return mapApprovalError(c, error, c.req.param("id"));
    }
  },
);

approvalRoutes.post(
  "/:pubKey/approval/candidates/:id/reject",
  zValidator("json", requestIdSchema.partial(), () => undefined),
  async (c) => {
    const forbidden = requireOwner(c);
    if (forbidden) return forbidden;

    const body = c.req.valid("json");
    if (!body.requestId?.trim()) {
      return missingRequestId(c);
    }

    try {
      const service = getApprovalServiceFromContext(c);
      const data = await service.approveCandidate({
        candidateId: c.req.param("id"),
        action: "reject",
        mode: "create_new",
        requestId: body.requestId,
      });
      return c.json({ data });
    } catch (error) {
      return mapApprovalError(c, error, c.req.param("id"));
    }
  },
);

approvalRoutes.post(
  "/:pubKey/approval/candidates/:id/skip",
  zValidator("json", requestIdSchema.partial(), () => undefined),
  async (c) => {
    const forbidden = requireOwner(c);
    if (forbidden) return forbidden;

    const body = c.req.valid("json");
    if (!body.requestId?.trim()) {
      return missingRequestId(c);
    }

    try {
      const service = getApprovalServiceFromContext(c);
      const data = await service.approveCandidate({
        candidateId: c.req.param("id"),
        action: "reject",
        mode: "create_new",
        requestId: body.requestId,
      });
      return c.json({ data });
    } catch (error) {
      return mapApprovalError(c, error, c.req.param("id"));
    }
  },
);

approvalRoutes.post(
  "/:pubKey/approval/undo",
  zValidator("json", undoSchema, (result, c) => {
    if (!result.success) {
      return validationError(c, result.error.message);
    }
  }),
  async (c) => {
    const forbidden = requireOwner(c);
    if (forbidden) return forbidden;

    try {
      const service = getApprovalServiceFromContext(c);
      const data = await service.undoLastAction(c.req.valid("json"));
      return c.json({ data });
    } catch (error) {
      return mapApprovalError(c, error);
    }
  },
);

approvalRoutes.put(
  "/:pubKey/anchors/:id",
  zValidator("json", microEditSchema.partial(), () => undefined),
  async (c) => {
    const forbidden = requireOwner(c);
    if (forbidden) return forbidden;

    const body = c.req.valid("json");
    if (!body.requestId?.trim()) {
      return missingRequestId(c);
    }

    try {
      const service = getApprovalServiceFromContext(c);
      const data = await service.microEditAsset({
        assetId: c.req.param("id"),
        question: body.question ?? "",
        answer: body.answer,
        source: body.source ?? "manual",
        requestId: body.requestId,
      });
      return c.json({ data });
    } catch (error) {
      return mapApprovalError(c, error);
    }
  },
);

approvalRoutes.post(
  "/:pubKey/anchors/:id/deny",
  zValidator("json", requestIdSchema.partial(), () => undefined),
  async (c) => {
    const forbidden = requireOwner(c);
    if (forbidden) return forbidden;

    const body = c.req.valid("json");
    if (!body.requestId?.trim()) {
      return missingRequestId(c);
    }

    try {
      const service = getApprovalServiceFromContext(c);
      const data = await service.denyAsset({
        assetId: c.req.param("id"),
        requestId: body.requestId,
      });
      return c.json({ data });
    } catch (error) {
      return mapApprovalError(c, error);
    }
  },
);
