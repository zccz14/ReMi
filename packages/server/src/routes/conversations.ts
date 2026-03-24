import { Hono } from "hono";
import type { Context } from "hono";
import type { ConnectionManager } from "../db/connection.js";
import type { Role } from "../middleware/role.js";
import { decodeStoredBody, extractStoredBodyText } from "../messaging/runtime.js";

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

function extractPreview(ciphertext: string): string | null {
  return extractStoredBodyText(decodeStoredBody(ciphertext)) || null;
}

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

  // Get latest direct message per peer from direct_messages
  const avatarRows = conn.raw
    .prepare(
      `SELECT
         CASE
           WHEN party_a_key = @pubKey THEN party_b_key
           ELSE party_a_key
         END AS peerKey,
         ciphertext_c AS ciphertextC,
         created_at AS createdAt
       FROM direct_messages AS dm
       WHERE (party_a_key = @pubKey OR party_b_key = @pubKey)
         AND NOT EXISTS (
           SELECT 1
           FROM direct_messages AS newer
           WHERE newer.party_a_key = dm.party_a_key
             AND newer.party_b_key = dm.party_b_key
             AND (
               newer.created_at > dm.created_at
               OR (newer.created_at = dm.created_at AND newer.id > dm.id)
             )
         )
       ORDER BY created_at DESC, dm.id DESC`,
    )
    .all({ pubKey }) as Array<{ peerKey: string; ciphertextC: string; createdAt: number }>;

  const avatarEntries = avatarRows.map((row) => ({
    type: "avatar" as const,
    pubKey: row.peerKey,
    lastMessage: extractPreview(row.ciphertextC),
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
    .prepare(
      `SELECT DISTINCT
         CASE
           WHEN party_a_key = ? THEN party_b_key
           ELSE party_a_key
         END AS peerKey
       FROM direct_messages
       WHERE party_a_key = ? OR party_b_key = ?
       ORDER BY peerKey ASC`,
    )
    .all(pubKey, pubKey, pubKey) as Array<{ peerKey: string }>;

  const data = rows.map((row) => ({ pubKey: row.peerKey }));

  return c.json({ data });
});
