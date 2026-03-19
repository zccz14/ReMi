import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, sql, desc } from "drizzle-orm";
import { soulAnchors } from "../db/schema.js";
import { upsertEmbedding, deleteEmbedding } from "../embedding/index.js";
import type { EmbeddingClient } from "../embedding/client.js";
import type { ChatClient } from "../llm/client.js";
import type { ConnectionManager } from "../db/connection.js";
import type { Role } from "../middleware/role.js";
import type { Context } from "hono";

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
  answer: z.string().optional(),
  source: z.enum(["interview", "manual"]),
});

const updateAnchorSchema = z.object({
  question: z.string().min(1).optional(),
  answer: z.string().nullable().optional(),
  source: z.enum(["interview", "manual"]).optional(),
});

function requireOwner(c: Context): Response | null {
  if (c.get("role") !== "owner") {
    return c.json({ error: "FORBIDDEN", message: "Owner access required" }, 403);
  }
  return null;
}

export const anchorRoutes = new Hono();

// GET /:pubKey/anchors
anchorRoutes.get("/:pubKey/anchors", (c) => {
  const forbidden = requireOwner(c);
  if (forbidden) return forbidden;

  const pubKey = c.req.param("pubKey");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const offset = Number(c.req.query("offset") ?? 0);

  const conn = c.get("connMgr").getConnection(pubKey);
  const items = conn.drizzle
    .select()
    .from(soulAnchors)
    .orderBy(desc(soulAnchors.createdAt))
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
  (c) => {
    const forbidden = requireOwner(c);
    if (forbidden) return forbidden;

    const pubKey = c.req.param("pubKey");
    const body = c.req.valid("json");
    const now = Date.now();
    const id = crypto.randomUUID();

    const conn = c.get("connMgr").getConnection(pubKey);
    conn.drizzle
      .insert(soulAnchors)
      .values({
        id,
        question: body.question,
        answer: body.answer ?? null,
        source: body.source,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const anchor = conn.drizzle.select().from(soulAnchors).where(eq(soulAnchors.id, id)).get();

    // Async embedding generation (fire-and-forget, non-blocking)
    const embeddingClient = c.get("embeddingClient");
    if (embeddingClient) {
      const text = body.question + "\n" + (body.answer ?? "");
      embeddingClient
        .embed([text])
        .then((vectors) => {
          upsertEmbedding(conn.raw, "soul_anchors_vec", id, vectors[0]);
        })
        .catch((err) => {
          console.error(`Failed to generate embedding for anchor ${id}:`, err);
        });
    }

    return c.json({ data: anchor }, 201);
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
  (c) => {
    const forbidden = requireOwner(c);
    if (forbidden) return forbidden;

    const pubKey = c.req.param("pubKey");
    const id = c.req.param("id");
    const body = c.req.valid("json");
    const now = Date.now();

    const conn = c.get("connMgr").getConnection(pubKey);
    const existing = conn.drizzle.select().from(soulAnchors).where(eq(soulAnchors.id, id)).get();

    if (!existing) {
      return c.json({ error: "ANCHOR_NOT_FOUND", message: "Anchor not found" }, 404);
    }

    conn.drizzle
      .update(soulAnchors)
      .set({ ...body, updatedAt: now })
      .where(eq(soulAnchors.id, id))
      .run();

    const updated = conn.drizzle.select().from(soulAnchors).where(eq(soulAnchors.id, id)).get();

    // Async embedding update (fire-and-forget)
    if (updated) {
      const embeddingClient = c.get("embeddingClient");
      if (embeddingClient) {
        const text = updated.question + "\n" + (updated.answer ?? "");
        embeddingClient
          .embed([text])
          .then((vectors) => {
            upsertEmbedding(conn.raw, "soul_anchors_vec", id, vectors[0]);
          })
          .catch((err) => {
            console.error(`Failed to update embedding for anchor ${id}:`, err);
          });
      }
    }

    return c.json({ data: updated });
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
  deleteEmbedding(conn.raw, "soul_anchors_vec", id);
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
  return c.body(null, 204);
});
