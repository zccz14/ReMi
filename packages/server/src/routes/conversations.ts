import { Hono } from "hono";
import type { Context } from "hono";
import type { ConnectionManager } from "../db/connection.js";
import type { Role } from "../middleware/role.js";

declare module "hono" {
  interface ContextVariableMap {
    signerPubKey: string;
    role: Role;
    connMgr: ConnectionManager;
  }
}

function requireOwner(c: Context): Response | null {
  if (c.get("role") !== "owner") {
    return c.json({ error: "FORBIDDEN", message: "Owner access required" }, 403);
  }
  return null;
}

export const conversationRoutes = new Hono();

// GET /:pubKey/conversations
conversationRoutes.get("/:pubKey/conversations", (c) => {
  const forbidden = requireOwner(c);
  if (forbidden) return forbidden;

  const pubKey = c.req.param("pubKey");
  const conn = c.get("connMgr").getConnection(pubKey);

  // Get latest interview message (ReMi conversation)
  const remiRow = conn.raw
    .prepare(
      `SELECT content, created_at AS createdAt FROM messages ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as { content: string; createdAt: number } | undefined;

  const remiEntry = {
    type: "remi" as const,
    lastMessage: remiRow?.content ?? null,
    lastMessageAt: remiRow?.createdAt ?? 0,
  };

  // Get latest message per visitor from reasoning_messages
  const avatarRows = conn.raw
    .prepare(
      `SELECT visitor_key AS visitorKey, content, created_at AS createdAt
       FROM reasoning_messages
       WHERE id IN (
         SELECT MAX(id) FROM reasoning_messages GROUP BY visitor_key
       )
       ORDER BY created_at DESC`,
    )
    .all() as Array<{ visitorKey: string; content: string; createdAt: number }>;

  const avatarEntries = avatarRows.map((row) => ({
    type: "avatar" as const,
    pubKey: row.visitorKey,
    lastMessage: row.content,
    lastMessageAt: row.createdAt,
  }));

  // Merge and sort by lastMessageAt desc, ReMi always included
  const allEntries = [remiEntry, ...avatarEntries];
  allEntries.sort((a, b) => b.lastMessageAt - a.lastMessageAt);

  return c.json({ data: allEntries });
});

// GET /:pubKey/contacts
conversationRoutes.get("/:pubKey/contacts", (c) => {
  const forbidden = requireOwner(c);
  if (forbidden) return forbidden;

  const pubKey = c.req.param("pubKey");
  const conn = c.get("connMgr").getConnection(pubKey);

  const rows = conn.raw
    .prepare(`SELECT DISTINCT visitor_key AS visitorKey FROM reasoning_messages`)
    .all() as Array<{ visitorKey: string }>;

  const data = rows.map((row) => ({ pubKey: row.visitorKey }));

  return c.json({ data });
});
