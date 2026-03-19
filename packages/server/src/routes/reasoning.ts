import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { sql, desc, inArray } from "drizzle-orm";
import { reasoningMessages, soulAnchors } from "../db/schema.js";
import { ReasoningEngine, type ReasoningSSEEmitter } from "../reasoning/engine.js";
import type { ConnectionManager } from "../db/connection.js";
import type { ChatClient } from "../llm/client.js";
import type { EmbeddingClient } from "../embedding/client.js";
import { searchSimilar } from "../embedding/index.js";
import type { SoulAnchor } from "../types.js";

function createEngine(
  conn: {
    raw: ReturnType<ConnectionManager["getConnection"]>["raw"];
    drizzle: ReturnType<ConnectionManager["getConnection"]>["drizzle"];
  },
  chatClient: ChatClient,
  embeddingClient: EmbeddingClient,
): ReasoningEngine {
  const deps = {
    chatClient,
    embeddingClient,

    async getMessages(visitorKey: string, limit: number) {
      const rows = conn.drizzle
        .select()
        .from(reasoningMessages)
        .where(sql`${reasoningMessages.visitorKey} = ${visitorKey}`)
        .orderBy(desc(reasoningMessages.id))
        .limit(limit)
        .all();
      return rows.reverse().map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
      }));
    },

    async saveMessage(
      visitorKey: string,
      role: "user" | "assistant",
      content: string,
      recalledAnchors?: string[],
    ): Promise<number> {
      const now = Date.now();
      const result = conn.drizzle
        .insert(reasoningMessages)
        .values({
          visitorKey,
          role,
          content,
          recalledAnchors: recalledAnchors ? JSON.stringify(recalledAnchors) : null,
          createdAt: now,
        })
        .run();
      return Number(result.lastInsertRowid);
    },

    async searchAnchors(embedding: number[]): Promise<SoulAnchor[]> {
      const results = searchSimilar(conn.raw, "soul_anchors_vec", embedding, 10);
      if (results.length === 0) return [];
      const ids = results.map((r) => r.id);
      return conn.drizzle
        .select()
        .from(soulAnchors)
        .where(inArray(soulAnchors.id, ids))
        .all() as SoulAnchor[];
    },

    async getCachedAnchorIds(visitorKey: string): Promise<string[]> {
      const lastAssistant = conn.drizzle
        .select({ recalledAnchors: reasoningMessages.recalledAnchors })
        .from(reasoningMessages)
        .where(
          sql`${reasoningMessages.visitorKey} = ${visitorKey} AND ${reasoningMessages.role} = 'assistant'`,
        )
        .orderBy(desc(reasoningMessages.id))
        .limit(1)
        .get();
      if (!lastAssistant?.recalledAnchors) return [];
      try {
        return JSON.parse(lastAssistant.recalledAnchors) as string[];
      } catch {
        return [];
      }
    },

    async getAnchorsByIds(ids: string[]): Promise<SoulAnchor[]> {
      if (ids.length === 0) return [];
      return conn.drizzle
        .select()
        .from(soulAnchors)
        .where(inArray(soulAnchors.id, ids))
        .all() as SoulAnchor[];
    },
  };

  return new ReasoningEngine(deps);
}

function createSSEEmitter(stream: {
  writeSSE: (message: { event: string; data: string }) => Promise<void>;
}): ReasoningSSEEmitter {
  return {
    emitThinking(narrative: string) {
      stream.writeSSE({ event: "thinking", data: narrative });
    },
    emitToken(content: string) {
      stream.writeSSE({ event: "token", data: content });
    },
    emitDone(data: { messageId: number; recalledAnchors: string[] }) {
      stream.writeSSE({
        event: "done",
        data: JSON.stringify(data),
      });
    },
    emitError(code: string, message: string) {
      stream.writeSSE({
        event: "error",
        data: JSON.stringify({ code, message }),
      });
    },
  };
}

export const reasoningRoutes = new Hono();

const messageSchema = z.object({
  content: z.string().min(1),
});

// GET /:pubKey/reasoning/messages
reasoningRoutes.get("/:pubKey/reasoning/messages", (c) => {
  const pubKey = c.req.param("pubKey");
  const visitorKey = c.get("signerPubKey");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const before = c.req.query("before") ? Number(c.req.query("before")) : undefined;

  const conn = c.get("connMgr").getConnection(pubKey);

  let query = conn.drizzle
    .select()
    .from(reasoningMessages)
    .where(sql`${reasoningMessages.visitorKey} = ${visitorKey}`)
    .orderBy(desc(reasoningMessages.id))
    .limit(limit + 1);

  if (before !== undefined) {
    query = conn.drizzle
      .select()
      .from(reasoningMessages)
      .where(
        sql`${reasoningMessages.visitorKey} = ${visitorKey} AND ${reasoningMessages.id} < ${before}`,
      )
      .orderBy(desc(reasoningMessages.id))
      .limit(limit + 1) as typeof query;
  }

  const rows = query.all();
  const hasMore = rows.length > limit;
  const items = rows
    .slice(0, limit)
    .reverse()
    .map((r) => ({
      ...r,
      recalled_anchors: r.recalledAnchors ? JSON.parse(r.recalledAnchors) : null,
      recalledAnchors: undefined,
      visitor_key: r.visitorKey,
      visitorKey: undefined,
      created_at: r.createdAt,
      createdAt: undefined,
    }));

  return c.json({ data: { items, hasMore } });
});

// POST /:pubKey/reasoning/message
reasoningRoutes.post(
  "/:pubKey/reasoning/message",
  zValidator("json", messageSchema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: result.error.message,
        },
        422,
      );
    }
  }),
  (c) => {
    const pubKey = c.req.param("pubKey");
    const visitorKey = c.get("signerPubKey");
    const { content } = c.req.valid("json");
    const chatClient = c.get("chatClient");
    const embeddingClient = c.get("embeddingClient");

    if (!chatClient || !embeddingClient) {
      return c.json(
        {
          error: "LLM_ERROR",
          message: "Chat or embedding client not configured",
        },
        500,
      );
    }

    const conn = c.get("connMgr").getConnection(pubKey);
    const engine = createEngine(conn, chatClient, embeddingClient);

    return streamSSE(c, async (stream) => {
      const emitter = createSSEEmitter(stream);
      await engine.handleMessage(content, visitorKey, emitter);
    });
  },
);
