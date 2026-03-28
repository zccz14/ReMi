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
import { logger, shortKey } from "../logger.js";
import { getApprovalServiceFromContext, mapApprovalError } from "./approval.js";

const log = logger.child({ module: "anchors" });

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
  source: z.enum(["interview", "manual", "reading"]),
});

const updateAnchorSchema = z.object({
  question: z.string().min(1).optional(),
  answer: z.string().nullable().optional(),
  source: z.enum(["interview", "manual", "reading"]).optional(),
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
  const conn = c.get("connMgr").getConnection(pubKey);
  conn.drizzle.delete(soulAnchors).where(eq(soulAnchors.id, id)).run();

  log.info({ soul: shortKey(pubKey), anchorId: id }, "Anchor deleted");
  return c.body(null, 204);
});

// DELETE /:pubKey/anchors (clear all)
anchorRoutes.delete("/:pubKey/anchors", (c) => {
  const forbidden = requireOwner(c);
  if (forbidden) return forbidden;

  const pubKey = c.req.param("pubKey");
  const conn = c.get("connMgr").getConnection(pubKey);
  conn.drizzle.delete(soulAnchors).run();
  // Clear vector table
  conn.raw.exec("DELETE FROM soul_anchors_vec");

  log.warn({ soul: shortKey(pubKey) }, "All anchors cleared");
  return c.body(null, 204);
});
