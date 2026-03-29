import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, sql, desc } from "drizzle-orm";
import { soulAnchors } from "../db/schema.js";
import type { EmbeddingClient } from "../embedding/client.js";
import type { ChatClient } from "../llm/client.js";
import type { ConnectionManager } from "../db/connection.js";
import type { Role } from "../middleware/role.js";
import type { Context } from "hono";
import { buildApprovalAlert } from "../approval/alerts.js";
import { logger, shortKey } from "../logger.js";
import { getApprovalServiceFromContext, mapApprovalError } from "./approval.js";

const log = logger.child({ module: "anchors" });

function emitDirectWriteBlocked(params: {
  ownerKey: string;
  routeOrModule: string;
  attemptedAction: string;
  assetId?: string;
}) {
  const alert = buildApprovalAlert({
    event: "direct_write_blocked",
    ownerKey: params.ownerKey,
    routeOrModule: params.routeOrModule,
    attemptedAction: params.attemptedAction,
    assetId: params.assetId,
  });

  if (alert) {
    logger.error(alert, alert.alertType);
  }
}

declare module "hono" {
  interface ContextVariableMap {
    signerPubKey: string;
    role: Role;
    connMgr: ConnectionManager;
    embeddingClient: EmbeddingClient | null;
    chatClient: ChatClient | null;
  }
}

const createAnchorSchema = z.object({
  question: z.string().min(1),
  answer: z.string().nullable().optional(),
  source: z.enum(["interview", "manual", "reading", "reasoning"]),
});

const updateAnchorSchema = z.object({
  question: z.string().min(1).optional(),
  answer: z.string().nullable().optional(),
  source: z.enum(["interview", "manual", "reading", "reasoning"]).optional(),
  requestId: z.string().trim().min(1).optional(),
});

const denyAnchorSchema = z.object({
  requestId: z.string().trim().min(1).optional(),
});

function requireOwner(c: Context): Response | null {
  if (c.get("role") !== "owner") {
    return c.json({ error: "FORBIDDEN", message: "Owner access required" }, 403);
  }
  return null;
}

function parseNonNegativeInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export const anchorRoutes = new Hono();

// GET /:pubKey/anchors
anchorRoutes.get("/:pubKey/anchors", (c) => {
  const forbidden = requireOwner(c);
  if (forbidden) return forbidden;

  const pubKey = c.req.param("pubKey");
  const limit = Math.min(parseNonNegativeInt(c.req.query("limit"), 50), 200);
  const offset = parseNonNegativeInt(c.req.query("offset"), 0);

  const conn = c.get("connMgr").getConnection(pubKey);
  const items = conn.drizzle
    .select()
    .from(soulAnchors)
    .orderBy(desc(soulAnchors.updatedAt), desc(soulAnchors.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  const [{ count }] = conn.drizzle
    .select({ count: sql<number>`count(*)` })
    .from(soulAnchors)
    .all();

  return c.json({
    data: { items, total: count, limit, offset },
  });
});

// POST /:pubKey/anchors
anchorRoutes.post(
  "/:pubKey/anchors",
  zValidator("json", createAnchorSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "VALIDATION_ERROR", message: result.error.message }, 422);
    }
  }),
  async (c) => {
    const forbidden = requireOwner(c);
    if (forbidden) return forbidden;

    const body = c.req.valid("json");
    const pubKey = c.req.param("pubKey");
    const candidate = getApprovalServiceFromContext(c).createCandidate(body);

    log.info(
      { soul: shortKey(pubKey), candidateId: candidate.id, source: body.source },
      "Manual candidate created",
    );

    return c.json({ data: candidate }, 201);
  },
);

// GET /:pubKey/anchors/:id
anchorRoutes.get("/:pubKey/anchors/:id", (c) => {
  const forbidden = requireOwner(c);
  if (forbidden) return forbidden;

  const pubKey = c.req.param("pubKey");
  const id = c.req.param("id");
  const conn = c.get("connMgr").getConnection(pubKey);
  const anchor = conn.drizzle.select().from(soulAnchors).where(eq(soulAnchors.id, id)).get();

  if (!anchor) {
    return c.json({ error: "ANCHOR_NOT_FOUND", message: "Anchor not found" }, 404);
  }
  return c.json({ data: anchor });
});

// PUT /:pubKey/anchors/:id
anchorRoutes.put(
  "/:pubKey/anchors/:id",
  zValidator("json", updateAnchorSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "VALIDATION_ERROR", message: result.error.message }, 422);
    }
  }),
  async (c) => {
    const forbidden = requireOwner(c);
    if (forbidden) return forbidden;

    const id = c.req.param("id");
    const body = c.req.valid("json");
    const requestId = body.requestId?.trim();

    if (!requestId) {
      return c.json({ error: "VALIDATION_ERROR", message: "requestId is required" }, 400);
    }

    const pubKey = c.req.param("pubKey");
    const conn = c.get("connMgr").getConnection(pubKey);
    const existing = conn.drizzle.select().from(soulAnchors).where(eq(soulAnchors.id, id)).get();

    if (!existing) {
      return c.json({ error: "ANCHOR_NOT_FOUND", message: "Anchor not found" }, 404);
    }

    try {
      const data = await getApprovalServiceFromContext(c).microEditAsset({
        assetId: id,
        question: body.question ?? existing.question,
        answer: body.answer === undefined ? existing.answer : body.answer,
        source: body.source ?? existing.source,
        requestId,
      });

      log.info({ soul: shortKey(pubKey), anchorId: id }, "Anchor updated through approval gateway");
      return c.json({ data });
    } catch (error) {
      return mapApprovalError(c, error);
    }
  },
);

anchorRoutes.post(
  "/:pubKey/anchors/:id/deny",
  zValidator("json", denyAnchorSchema.partial(), () => undefined),
  async (c) => {
    const forbidden = requireOwner(c);
    if (forbidden) return forbidden;

    const requestId = c.req.valid("json").requestId?.trim();
    if (!requestId) {
      return c.json({ error: "VALIDATION_ERROR", message: "requestId is required" }, 400);
    }

    try {
      const data = await getApprovalServiceFromContext(c).denyAsset({
        assetId: c.req.param("id"),
        requestId,
      });
      return c.json({ data });
    } catch (error) {
      return mapApprovalError(c, error);
    }
  },
);

// DELETE /:pubKey/anchors/:id
anchorRoutes.delete("/:pubKey/anchors/:id", (c) => {
  const forbidden = requireOwner(c);
  if (forbidden) return forbidden;

  const pubKey = c.req.param("pubKey");
  const id = c.req.param("id");

  emitDirectWriteBlocked({
    ownerKey: pubKey,
    routeOrModule: "routes/anchors",
    attemptedAction: "DELETE /:pubKey/anchors/:id",
    assetId: id,
  });
  log.warn({ soul: shortKey(pubKey), anchorId: id }, "Legacy single-anchor delete path disabled");
  return c.json(
    {
      error: "METHOD_NOT_ALLOWED",
      message: "Legacy delete is disabled; use the approval gateway instead",
    },
    405,
  );
});

// DELETE /:pubKey/anchors (clear all)
anchorRoutes.delete("/:pubKey/anchors", (c) => {
  const forbidden = requireOwner(c);
  if (forbidden) return forbidden;

  const pubKey = c.req.param("pubKey");

  emitDirectWriteBlocked({
    ownerKey: pubKey,
    routeOrModule: "routes/anchors",
    attemptedAction: "DELETE /:pubKey/anchors",
  });
  log.warn({ soul: shortKey(pubKey) }, "Legacy bulk anchor delete path disabled");
  return c.json(
    {
      error: "METHOD_NOT_ALLOWED",
      message: "Legacy bulk delete is disabled; use the approval gateway instead",
    },
    405,
  );
});
