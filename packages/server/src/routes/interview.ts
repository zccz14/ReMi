import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { sql, desc, inArray } from "drizzle-orm";
import { messages, soulAnchors } from "../db/schema.js";
import { InterviewEngine, type SSEEmitter } from "../interview/engine.js";
import type { ConnectionManager } from "../db/connection.js";
import type { ChatClient } from "../llm/client.js";
import type { EmbeddingClient } from "../embedding/client.js";
import { searchSimilar, upsertEmbedding } from "../embedding/index.js";
import type { SoulAnchor } from "../types.js";
import type { Context } from "hono";
import { logger, shortKey } from "../logger.js";

const log = logger.child({ module: "route:interview" });

function requireOwner(c: Context): Response | null {
  if (c.get("role") !== "owner") {
    return c.json({ error: "FORBIDDEN", message: "Owner access required" }, 403);
  }
  return null;
}

function parsePositiveInt(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function createEngine(
  conn: {
    raw: ReturnType<ConnectionManager["getConnection"]>["raw"];
    drizzle: ReturnType<ConnectionManager["getConnection"]>["drizzle"];
  },
  chatClient: ChatClient,
  embeddingClient: EmbeddingClient,
): InterviewEngine {
  const deps = {
    chatClient,
    embeddingClient,

    async getMessages(limit: number) {
      const rows = conn.drizzle
        .select()
        .from(messages)
        .orderBy(desc(messages.id))
        .limit(limit)
        .all();
      return rows.reverse().map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        created_at: r.createdAt,
      }));
    },

    async cleanupEmptyAssistantMessages(): Promise<number> {
      const result = conn.drizzle
        .delete(messages)
        .where(sql`${messages.role} = 'assistant' AND trim(${messages.content}) = ''`)
        .run();
      return result.changes ?? 0;
    },

    async saveMessage(role: "user" | "assistant", content: string): Promise<number> {
      const now = Date.now();
      const result = conn.drizzle.insert(messages).values({ role, content, createdAt: now }).run();
      return Number(result.lastInsertRowid);
    },

    async getAnchors(limit: number): Promise<SoulAnchor[]> {
      return conn.drizzle.select().from(soulAnchors).limit(limit).all() as SoulAnchor[];
    },

    async saveAnchors(anchors: { question: string; answer: string }[]): Promise<void> {
      for (const anchor of anchors) {
        const id = crypto.randomUUID();
        const now = Date.now();
        conn.drizzle
          .insert(soulAnchors)
          .values({
            id,
            question: anchor.question,
            answer: anchor.answer,
            source: "interview",
            createdAt: now,
            updatedAt: now,
          })
          .run();

        // Fire-and-forget embedding
        const text = anchor.question + "\n" + anchor.answer;
        embeddingClient
          .embed([text])
          .then((vectors) => {
            upsertEmbedding(conn.raw, "soul_anchors_vec", id, vectors[0]);
          })
          .catch((err) => {
            log.error({ err, anchorId: id }, "Failed to generate embedding for interview anchor");
          });
      }
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

    async getAnchorCount(): Promise<number> {
      const [{ count }] = conn.drizzle
        .select({ count: sql<number>`count(*)` })
        .from(soulAnchors)
        .all();
      return count;
    },
  };

  return new InterviewEngine(deps);
}

function createSSEEmitter(stream: {
  writeSSE: (message: { event: string; data: string }) => Promise<void>;
}): SSEEmitter {
  return {
    async emitThinking(narrative: string) {
      await stream.writeSSE({ event: "thinking", data: narrative });
    },
    async emitToken(content: string) {
      await stream.writeSSE({ event: "token", data: content });
    },
    async emitDone(data: { messageId: number; anchorsExtracted: number }) {
      await stream.writeSSE({ event: "done", data: JSON.stringify(data) });
    },
    async emitError(code: string, message: string) {
      await stream.writeSSE({ event: "error", data: JSON.stringify({ code, message }) });
    },
    async emitPhase(data: { phase: string; label?: string }) {
      await stream.writeSSE({ event: "phase", data: JSON.stringify(data) });
    },
  };
}

export const interviewRoutes = new Hono();

// GET /:pubKey/interview/status
interviewRoutes.get("/:pubKey/interview/status", (c) => {
  const forbidden = requireOwner(c);
  if (forbidden) return forbidden;

  const pubKey = c.req.param("pubKey");
  const conn = c.get("connMgr").getConnection(pubKey);

  const [{ anchorCount }] = conn.drizzle
    .select({ anchorCount: sql<number>`count(*)` })
    .from(soulAnchors)
    .all();

  const [{ messageCount }] = conn.drizzle
    .select({ messageCount: sql<number>`count(*)` })
    .from(messages)
    .all();

  const lastMessage = conn.drizzle
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .orderBy(desc(messages.createdAt))
    .limit(1)
    .get();

  return c.json({
    data: {
      totalAnchors: anchorCount,
      totalMessages: messageCount,
      lastActiveAt: lastMessage?.createdAt ?? null,
    },
  });
});

// GET /:pubKey/interview/messages
interviewRoutes.get("/:pubKey/interview/messages", (c) => {
  const forbidden = requireOwner(c);
  if (forbidden) return forbidden;

  const pubKey = c.req.param("pubKey");
  const limitQuery = c.req.query("limit");
  const beforeQuery = c.req.query("before");

  const parsedLimit = parsePositiveInt(limitQuery);
  if (parsedLimit === null) {
    return c.json({ error: "VALIDATION_ERROR", message: "limit must be a positive integer" }, 422);
  }

  const parsedBefore = parsePositiveInt(beforeQuery);
  if (parsedBefore === null) {
    return c.json({ error: "VALIDATION_ERROR", message: "before must be a positive integer" }, 422);
  }

  const limit = Math.min(parsedLimit ?? 50, 200);
  const before = parsedBefore;

  const conn = c.get("connMgr").getConnection(pubKey);

  let query = conn.drizzle
    .select()
    .from(messages)
    .orderBy(desc(messages.id))
    .limit(limit + 1);

  if (before !== undefined) {
    query = conn.drizzle
      .select()
      .from(messages)
      .where(sql`${messages.id} < ${before}`)
      .orderBy(desc(messages.id))
      .limit(limit + 1) as typeof query;
  }

  const rows = query.all();
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).reverse();

  return c.json({
    data: {
      items,
      hasMore,
    },
  });
});

const messageSchema = z.object({
  content: z.string().min(1),
});

// POST /:pubKey/interview/start
interviewRoutes.post("/:pubKey/interview/start", (c) => {
  const forbidden = requireOwner(c);
  if (forbidden) return forbidden;

  const pubKey = c.req.param("pubKey");
  const chatClient = c.get("chatClient");
  const embeddingClient = c.get("embeddingClient");

  if (!chatClient || !embeddingClient) {
    return c.json({ error: "LLM_ERROR", message: "Chat or embedding client not configured" }, 500);
  }

  log.info({ soul: shortKey(pubKey) }, "Interview start requested");

  const conn = c.get("connMgr").getConnection(pubKey);
  const engine = createEngine(conn, chatClient, embeddingClient);

  return streamSSE(c, async (stream) => {
    const emitter = createSSEEmitter(stream);
    await engine.start(emitter);
  });
});

// POST /:pubKey/interview/message
interviewRoutes.post(
  "/:pubKey/interview/message",
  zValidator("json", messageSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "VALIDATION_ERROR", message: result.error.message }, 422);
    }
  }),
  (c) => {
    const forbidden = requireOwner(c);
    if (forbidden) return forbidden;

    const pubKey = c.req.param("pubKey");
    const { content } = c.req.valid("json");
    const chatClient = c.get("chatClient");
    const embeddingClient = c.get("embeddingClient");

    if (!chatClient || !embeddingClient) {
      return c.json(
        { error: "LLM_ERROR", message: "Chat or embedding client not configured" },
        500,
      );
    }

    log.info({ soul: shortKey(pubKey) }, "Interview message received");

    const conn = c.get("connMgr").getConnection(pubKey);
    const engine = createEngine(conn, chatClient, embeddingClient);

    return streamSSE(c, async (stream) => {
      const emitter = createSSEEmitter(stream);
      await engine.handleMessage(content, emitter);
    });
  },
);
