import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { inArray } from "drizzle-orm";
import { verify as verifySignature } from "@remi/crypto";
import { isAbsolute } from "node:path";

import { AvatarInferenceRuntime } from "../avatar/runtime.js";
import type { AvatarInferenceMessage } from "../avatar/model.js";
import { soulAnchors } from "../db/schema.js";
import type { ConnectionManager } from "../db/connection.js";
import type { ChatClient } from "../llm/client.js";
import type { EmbeddingClient } from "../embedding/client.js";
import type { SoulAnchor } from "../types.js";
import { logger, shortKey } from "../logger.js";
import { canonicalizeBodyJson } from "../messaging/body.js";
import { createLatestReasoningDebugArtifactWriter } from "../reasoning/debug-artifact.js";
import {
  applyReceiptPatch,
  buildCanonicalFact,
  computeMessageHash,
  type ReceiptState,
} from "../messaging/ledger.js";
import { getPartySlot, sortPartyKeys } from "../messaging/slots.js";
import {
  decodeStoredBody,
  encryptStoredBody,
  extractStoredBodyText,
  type StoredBody,
} from "../messaging/runtime.js";
import { createSseHeartbeat } from "../lib/sse-heartbeat.js";

const log = logger.child({ module: "route:reasoning" });

type DirectMessageRow = {
  id: number;
  shared_message_id: string;
  party_a_key: string;
  party_b_key: string;
  sender_key: string;
  sender_kind: "owner" | "avatar";
  ciphertext_a: string;
  ciphertext_b: string;
  ciphertext_c: string;
  message_hash: string;
  prev_message_hash: string | null;
  created_at: number;
  delivered_at_a: number | null;
  delivered_at_b: number | null;
  read_at_a: number | null;
  read_at_b: number | null;
  attested_at_a: number | null;
  attested_at_b: number | null;
  sign_a: string | null;
  sign_b: string | null;
  status_reason_a: string | null;
  status_reason_b: string | null;
};

type DirectMessageInsert = Omit<DirectMessageRow, "id">;

const threadLocks = new Map<string, Promise<void>>();
const BLOCKED_REASON = "blocked:rollback_failed";

const bodyJsonSchema = z
  .object({
    type: z.string().min(1),
    version: z.number(),
  })
  .passthrough();

const messageSchema = z
  .object({
    content: z.string().min(1).optional(),
    body_json: bodyJsonSchema.optional(),
  })
  .refine((value) => value.body_json !== undefined || value.content !== undefined, {
    message: "content or body_json is required",
  });

const attestSchema = z.object({
  signature: z.string().min(1),
});

const emptyBodySchema = z.object({}).passthrough();

function buildConversationKeys(pubKey: string, visitorKey: string) {
  return sortPartyKeys(pubKey, visitorKey);
}

function mapSenderRole(senderKey: string, viewerKey: string): "user" | "assistant" {
  return senderKey === viewerKey ? "user" : "assistant";
}

async function withThreadLock<T>(threadKey: string, fn: () => Promise<T>): Promise<T> {
  const previous = threadLocks.get(threadKey) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  threadLocks.set(
    threadKey,
    previous.then(() => current),
  );

  await previous;
  try {
    return await fn();
  } finally {
    release?.();
    if (threadLocks.get(threadKey) === current) {
      threadLocks.delete(threadKey);
    }
  }
}

function createRuntime(input: {
  ownerConn: ReturnType<ConnectionManager["getConnection"]>;
  chatClient: ChatClient;
  embeddingClient: EmbeddingClient | null;
  debugArtifactRootDir: string | null;
}) {
  return new AvatarInferenceRuntime({
    ownerConn: input.ownerConn,
    chatClient: input.chatClient,
    embeddingClient: input.embeddingClient,
    debugArtifactWriter: input.debugArtifactRootDir
      ? createLatestReasoningDebugArtifactWriter({ rootDir: input.debugArtifactRootDir })
      : undefined,
  });
}

const CACHE_ELIGIBLE_SELECTION_STRATEGIES = new Set([null, undefined, "batch-recall"]);
const RUNTIME_CONVERSATION_WINDOW = 20;

function mapConversationRowsToRuntimeMessages(
  rows: DirectMessageRow[],
  viewerKey: string,
): AvatarInferenceMessage[] {
  return rows.map((row) => ({
    role: mapSenderRole(row.sender_key, viewerKey),
    content: extractStoredBodyText(decodeStoredBody(row.ciphertext_c)),
  }));
}

function getCachedAnchorIds(
  db: ReturnType<ConnectionManager["getConnection"]>["raw"],
  parties: { partyAKey: string; partyBKey: string },
  ownerPubKey: string,
): string[] {
  const lastAssistant = db
    .prepare(
      `SELECT ciphertext_c
       FROM direct_messages
       WHERE party_a_key = ? AND party_b_key = ? AND sender_key = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(parties.partyAKey, parties.partyBKey, ownerPubKey) as { ciphertext_c: string } | undefined;
  const body = lastAssistant ? decodeStoredBody(lastAssistant.ciphertext_c) : null;

  const anchorSelectionStrategy =
    typeof body?.anchorSelectionStrategy === "string" ||
    body?.anchorSelectionStrategy === null ||
    body?.anchorSelectionStrategy === undefined
      ? body?.anchorSelectionStrategy
      : undefined;

  if (!body || !CACHE_ELIGIBLE_SELECTION_STRATEGIES.has(anchorSelectionStrategy)) {
    return [];
  }

  return Array.isArray(body.recalledAnchors)
    ? body.recalledAnchors.filter((value): value is string => typeof value === "string")
    : [];
}

function getAnchorsByIds(
  ownerConn: ReturnType<ConnectionManager["getConnection"]>,
  ids: string[],
): SoulAnchor[] {
  if (ids.length === 0) return [];
  const anchors = ownerConn.drizzle
    .select()
    .from(soulAnchors)
    .where(inArray(soulAnchors.id, ids))
    .all() as SoulAnchor[];

  const anchorMap = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  return ids.map((id) => anchorMap.get(id)).filter((anchor): anchor is SoulAnchor => !!anchor);
}

function resolveReasoningDebugArtifactRootDir(): string | null {
  const configured = process.env.REMI_REASONING_DEBUG_ARTIFACT_ROOT_DIR?.trim();
  return configured && isAbsolute(configured) ? configured : null;
}

function createSSEEmitter(stream: {
  writeSSE: (message: { event: string; data: string }) => Promise<void>;
}) {
  return {
    async emitThinking(narrative: string) {
      await stream.writeSSE({ event: "thinking", data: narrative });
    },
    async emitToken(content: string) {
      await stream.writeSSE({ event: "token", data: content });
    },
    async emitDone(data: {
      messageId: number;
      recalledAnchors: string[];
      shared_message_id?: string;
      content?: string;
    }) {
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify(data),
      });
    },
    async emitError(code: string, message: string) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ code, message }),
      });
    },
  };
}

function buildStoredBody(input: z.infer<typeof messageSchema>): StoredBody {
  if (input.body_json) {
    return JSON.parse(canonicalizeBodyJson(input.body_json)) as StoredBody;
  }

  return {
    type: "text",
    version: 1,
    text: input.content ?? "",
  };
}

function listConversationRows(
  db: ReturnType<ConnectionManager["getConnection"]>["raw"],
  parties: { partyAKey: string; partyBKey: string },
  limit: number,
  before?: number,
): DirectMessageRow[] {
  const params: Array<string | number> = [parties.partyAKey, parties.partyBKey];
  const beforeClause = before !== undefined ? "AND id < ?" : "";
  if (before !== undefined) {
    params.push(before);
  }
  params.push(limit + 1);

  return db
    .prepare(
      `SELECT *
       FROM direct_messages
       WHERE party_a_key = ?
         AND party_b_key = ?
         ${beforeClause}
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(...params) as DirectMessageRow[];
}

function getLatestMessageHash(
  db: ReturnType<ConnectionManager["getConnection"]>["raw"],
  parties: { partyAKey: string; partyBKey: string },
): string | null {
  const row = db
    .prepare(
      `SELECT message_hash
       FROM direct_messages
       WHERE party_a_key = ? AND party_b_key = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(parties.partyAKey, parties.partyBKey) as { message_hash: string } | undefined;

  return row?.message_hash ?? null;
}

function insertDirectMessage(
  db: ReturnType<ConnectionManager["getConnection"]>["raw"],
  value: DirectMessageInsert,
): number {
  const result = db
    .prepare(
      `INSERT INTO direct_messages (
         shared_message_id,
         party_a_key,
         party_b_key,
         sender_key,
         sender_kind,
         ciphertext_a,
         ciphertext_b,
         ciphertext_c,
         message_hash,
         prev_message_hash,
         created_at,
         delivered_at_a,
         delivered_at_b,
         read_at_a,
         read_at_b,
         attested_at_a,
         attested_at_b,
         sign_a,
         sign_b,
         status_reason_a,
         status_reason_b
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      value.shared_message_id,
      value.party_a_key,
      value.party_b_key,
      value.sender_key,
      value.sender_kind,
      value.ciphertext_a,
      value.ciphertext_b,
      value.ciphertext_c,
      value.message_hash,
      value.prev_message_hash,
      value.created_at,
      value.delivered_at_a,
      value.delivered_at_b,
      value.read_at_a,
      value.read_at_b,
      value.attested_at_a,
      value.attested_at_b,
      value.sign_a,
      value.sign_b,
      value.status_reason_a,
      value.status_reason_b,
    );

  return Number(result.lastInsertRowid);
}

function deleteDirectMessage(
  db: ReturnType<ConnectionManager["getConnection"]>["raw"],
  sharedMessageId: string,
): void {
  db.prepare(`DELETE FROM direct_messages WHERE shared_message_id = ?`).run(sharedMessageId);
}

function updateDirectMessage(
  db: ReturnType<ConnectionManager["getConnection"]>["raw"],
  sharedMessageId: string,
  receipt: ReceiptState,
): void {
  const result = db
    .prepare(
      `UPDATE direct_messages
     SET delivered_at_a = ?,
         delivered_at_b = ?,
         read_at_a = ?,
         read_at_b = ?,
         attested_at_a = ?,
         attested_at_b = ?,
         sign_a = ?,
         sign_b = ?,
         status_reason_a = ?,
         status_reason_b = ?
     WHERE shared_message_id = ?`,
    )
    .run(
      receipt.delivered_at_a,
      receipt.delivered_at_b,
      receipt.read_at_a,
      receipt.read_at_b,
      receipt.attested_at_a,
      receipt.attested_at_b,
      receipt.sign_a,
      receipt.sign_b,
      receipt.status_reason_a,
      receipt.status_reason_b,
      sharedMessageId,
    );

  if (result.changes !== 1) {
    throw new Error(`Replica update failed for ${sharedMessageId}`);
  }
}

function getDirectMessageBySharedId(
  db: ReturnType<ConnectionManager["getConnection"]>["raw"],
  sharedMessageId: string,
): DirectMessageRow | null {
  return (
    (db
      .prepare(`SELECT * FROM direct_messages WHERE shared_message_id = ? LIMIT 1`)
      .get(sharedMessageId) as DirectMessageRow | undefined) ?? null
  );
}

function isThreadBlocked(
  db: ReturnType<ConnectionManager["getConnection"]>["raw"],
  parties: { partyAKey: string; partyBKey: string },
): boolean {
  const row = db
    .prepare(
      `SELECT 1
       FROM direct_messages
       WHERE party_a_key = ?
         AND party_b_key = ?
         AND (status_reason_a = ? OR status_reason_b = ?)
       LIMIT 1`,
    )
    .get(parties.partyAKey, parties.partyBKey, BLOCKED_REASON, BLOCKED_REASON);

  return Boolean(row);
}

async function persistDirectMessage(input: {
  connMgr: ConnectionManager;
  ownerPubKey: string;
  requesterPubKey: string;
  senderKey: string;
  senderKind: "owner" | "avatar";
  body: StoredBody;
}): Promise<{ localMessageId: number; sharedMessageId: string }> {
  const parties = buildConversationKeys(input.ownerPubKey, input.requesterPubKey);
  const threadKey = `${parties.partyAKey}:${parties.partyBKey}`;

  return withThreadLock(threadKey, async () => {
    const ownerConn = input.connMgr.getConnection(input.ownerPubKey, { create: true });
    const requesterConn = input.connMgr.getConnection(input.requesterPubKey, { create: true });

    if (isThreadBlocked(ownerConn.raw, parties) || isThreadBlocked(requesterConn.raw, parties)) {
      throw new Error("Conversation is blocked pending repair");
    }

    const createdAt = Date.now();
    const ownerHead = getLatestMessageHash(ownerConn.raw, parties);
    const requesterHead = getLatestMessageHash(requesterConn.raw, parties);
    if (ownerHead !== requesterHead) {
      throw new Error("Conversation replicas diverged and require repair");
    }

    const prevMessageHash = ownerHead;
    const sharedMessageId = crypto.randomUUID();
    const encrypted = encryptStoredBody(input.body, parties);
    const fact = buildCanonicalFact({
      sharedMessageId,
      partyAKey: parties.partyAKey,
      partyBKey: parties.partyBKey,
      senderKey: input.senderKey,
      senderKind: input.senderKind,
      bodyJson: encrypted.bodyJson,
      createdAt,
      prevMessageHash,
    });
    const messageHash = computeMessageHash(fact);

    const value: DirectMessageInsert = {
      shared_message_id: sharedMessageId,
      party_a_key: parties.partyAKey,
      party_b_key: parties.partyBKey,
      sender_key: input.senderKey,
      sender_kind: input.senderKind,
      ciphertext_a: encrypted.ciphertextA,
      ciphertext_b: encrypted.ciphertextB,
      ciphertext_c: encrypted.ciphertextC,
      message_hash: messageHash,
      prev_message_hash: prevMessageHash,
      created_at: createdAt,
      delivered_at_a: createdAt,
      delivered_at_b: createdAt,
      read_at_a: null,
      read_at_b: null,
      attested_at_a: null,
      attested_at_b: null,
      sign_a: null,
      sign_b: null,
      status_reason_a: null,
      status_reason_b: null,
    };

    const ownerMessageId = insertDirectMessage(ownerConn.raw, value);
    try {
      const requesterMessageId = insertDirectMessage(requesterConn.raw, value);
      return {
        localMessageId: requesterConn === ownerConn ? ownerMessageId : requesterMessageId,
        sharedMessageId,
      };
    } catch (error) {
      try {
        deleteDirectMessage(ownerConn.raw, sharedMessageId);
      } catch {
        ownerConn.raw
          .prepare(
            `UPDATE direct_messages
             SET status_reason_a = ?, status_reason_b = ?
             WHERE shared_message_id = ?`,
          )
          .run(BLOCKED_REASON, BLOCKED_REASON, sharedMessageId);
      }
      throw error;
    }
  });
}

function rowToReceiptState(row: DirectMessageRow): ReceiptState {
  return {
    delivered_at_a: row.delivered_at_a,
    delivered_at_b: row.delivered_at_b,
    read_at_a: row.read_at_a,
    read_at_b: row.read_at_b,
    attested_at_a: row.attested_at_a,
    attested_at_b: row.attested_at_b,
    sign_a: row.sign_a,
    sign_b: row.sign_b,
    status_reason_a: row.status_reason_a,
    status_reason_b: row.status_reason_b,
  };
}

async function applyReceiptToReplicas(input: {
  connMgr: ConnectionManager;
  ownerPubKey: string;
  requesterPubKey: string;
  sharedMessageId: string;
  patch:
    | { slot: "a" | "b"; readAt: number; statusReason?: string | null }
    | { slot: "a" | "b"; attestedAt: number; sign: string; statusReason?: string | null };
}): Promise<DirectMessageRow> {
  return withThreadLock(`receipt:${input.sharedMessageId}`, async () => {
    const ownerConn = input.connMgr.getConnection(input.ownerPubKey, { create: true });
    const requesterConn = input.connMgr.getConnection(input.requesterPubKey, { create: true });
    const ownerRow = getDirectMessageBySharedId(ownerConn.raw, input.sharedMessageId);

    if (!ownerRow) {
      throw new Error("Message not found");
    }

    const nextReceipt = applyReceiptPatch(rowToReceiptState(ownerRow), input.patch);
    updateDirectMessage(ownerConn.raw, input.sharedMessageId, nextReceipt);

    try {
      updateDirectMessage(requesterConn.raw, input.sharedMessageId, nextReceipt);
    } catch {
      const driftedReceipt = applyReceiptPatch(nextReceipt, {
        slot: input.patch.slot,
        statusReason: `pending_receipt_sync:${"readAt" in input.patch ? "read" : "attest"}`,
      });
      updateDirectMessage(ownerConn.raw, input.sharedMessageId, driftedReceipt);
    }

    return getDirectMessageBySharedId(ownerConn.raw, input.sharedMessageId) as DirectMessageRow;
  });
}

function validateStoredMessage(row: DirectMessageRow): { tampered: boolean } {
  const body = decodeStoredBody(row.ciphertext_c);
  if (!body) {
    return { tampered: true };
  }

  const reconstructedHash = computeMessageHash(
    buildCanonicalFact({
      sharedMessageId: row.shared_message_id,
      partyAKey: row.party_a_key,
      partyBKey: row.party_b_key,
      senderKey: row.sender_key,
      senderKind: row.sender_kind,
      bodyJson: body,
      createdAt: row.created_at,
      prevMessageHash: row.prev_message_hash,
    }),
  );

  return { tampered: reconstructedHash !== row.message_hash };
}

function countChainBreaks(rows: DirectMessageRow[]): number {
  const orderedRows = [...rows].reverse();
  let previousHash: string | null = null;
  let chainBreaks = 0;

  for (const row of orderedRows) {
    if (row.prev_message_hash !== previousHash) {
      chainBreaks += 1;
    }
    previousHash = row.message_hash;
  }

  return chainBreaks;
}

function mergeReplicaState(
  localRow: DirectMessageRow,
  remoteRow: DirectMessageRow | null,
): ReceiptState {
  if (!remoteRow || remoteRow.message_hash !== localRow.message_hash) {
    return rowToReceiptState(localRow);
  }

  return {
    delivered_at_a: Math.max(localRow.delivered_at_a ?? 0, remoteRow.delivered_at_a ?? 0) || null,
    delivered_at_b: Math.max(localRow.delivered_at_b ?? 0, remoteRow.delivered_at_b ?? 0) || null,
    read_at_a: Math.max(localRow.read_at_a ?? 0, remoteRow.read_at_a ?? 0) || null,
    read_at_b: Math.max(localRow.read_at_b ?? 0, remoteRow.read_at_b ?? 0) || null,
    attested_at_a: Math.max(localRow.attested_at_a ?? 0, remoteRow.attested_at_a ?? 0) || null,
    attested_at_b: Math.max(localRow.attested_at_b ?? 0, remoteRow.attested_at_b ?? 0) || null,
    sign_a:
      remoteRow.attested_at_a && (remoteRow.attested_at_a ?? 0) >= (localRow.attested_at_a ?? 0)
        ? remoteRow.sign_a
        : localRow.sign_a,
    sign_b:
      remoteRow.attested_at_b && (remoteRow.attested_at_b ?? 0) >= (localRow.attested_at_b ?? 0)
        ? remoteRow.sign_b
        : localRow.sign_b,
    status_reason_a:
      (remoteRow.read_at_a ?? 0) >= (localRow.read_at_a ?? 0)
        ? remoteRow.status_reason_a
        : localRow.status_reason_a,
    status_reason_b:
      (remoteRow.read_at_b ?? 0) >= (localRow.read_at_b ?? 0)
        ? remoteRow.status_reason_b
        : localRow.status_reason_b,
  };
}

function mapMessageForResponse(
  localRow: DirectMessageRow,
  remoteRow: DirectMessageRow | null,
  viewerKey: string,
) {
  const body = decodeStoredBody(localRow.ciphertext_c);
  const receipt = mergeReplicaState(localRow, remoteRow);

  return {
    id: localRow.id,
    shared_message_id: localRow.shared_message_id,
    sender_key: localRow.sender_key,
    sender_kind: localRow.sender_kind,
    role: mapSenderRole(localRow.sender_key, viewerKey),
    body,
    content: extractStoredBodyText(body),
    created_at: localRow.created_at,
    delivered_at_a: receipt.delivered_at_a,
    delivered_at_b: receipt.delivered_at_b,
    read_at_a: receipt.read_at_a,
    read_at_b: receipt.read_at_b,
    attested_at_a: receipt.attested_at_a,
    attested_at_b: receipt.attested_at_b,
    sign_a: receipt.sign_a,
    sign_b: receipt.sign_b,
    status_reason_a: receipt.status_reason_a,
    status_reason_b: receipt.status_reason_b,
  };
}

export const reasoningRoutes = new Hono();

// GET /:pubKey/reasoning/messages
reasoningRoutes.get("/:pubKey/reasoning/messages", (c) => {
  const ownerPubKey = c.req.param("pubKey");
  const requesterPubKey = c.get("signerPubKey");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const before = c.req.query("before") ? Number(c.req.query("before")) : undefined;
  const parties = buildConversationKeys(ownerPubKey, requesterPubKey);
  const requesterConn = c.get("connMgr").getConnection(requesterPubKey, { create: true });
  const remoteConn = c.get("connMgr").getConnection(ownerPubKey, { create: true });

  const rows = listConversationRows(requesterConn.raw, parties, limit, before);
  const hasMore = rows.length > limit;
  const items = rows
    .slice(0, limit)
    .reverse()
    .map((row) =>
      mapMessageForResponse(
        row,
        getDirectMessageBySharedId(remoteConn.raw, row.shared_message_id),
        requesterPubKey,
      ),
    );

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
    const ownerPubKey = c.req.param("pubKey");
    const requesterPubKey = c.get("signerPubKey");
    const messageInput = c.req.valid("json");
    const chatClient = c.get("chatClient");
    const embeddingClient = c.get("embeddingClient");

    if (!chatClient) {
      return c.json(
        {
          error: "LLM_ERROR",
          message: "Chat client not configured",
        },
        500,
      );
    }

    log.info(
      { soul: shortKey(ownerPubKey), visitor: shortKey(requesterPubKey) },
      "Reasoning message received",
    );

    const connMgr = c.get("connMgr");
    const ownerConn = connMgr.getConnection(ownerPubKey, { create: true });
    const requesterConn = connMgr.getConnection(requesterPubKey, { create: true });
    const requestBody = buildStoredBody(messageInput);
    const parties = buildConversationKeys(ownerPubKey, requesterPubKey);
    const runtime = createRuntime({
      ownerConn,
      chatClient,
      embeddingClient,
      debugArtifactRootDir: resolveReasoningDebugArtifactRootDir(),
    });

    return streamSSE(c, async (stream) => {
      const emitter = createSSEEmitter(stream);
      let transportFailure: unknown = null;

      function markTransportFailure(error: unknown) {
        if (transportFailure === null) {
          transportFailure = error;
        }
        return transportFailure;
      }

      function isTransportFailure(error: unknown) {
        return transportFailure !== null && error === transportFailure;
      }

      function ensureStreamHealthy() {
        if (transportFailure !== null) {
          throw transportFailure;
        }
      }

      const heartbeat = createSseHeartbeat({
        writeComment: async (frame) => {
          await stream.write(frame);
        },
        onError: (error) => {
          markTransportFailure(error);
        },
      });

      async function emitThinking(narrative: string) {
        ensureStreamHealthy();
        try {
          await emitter.emitThinking(narrative);
        } catch (error) {
          throw markTransportFailure(error);
        }
        heartbeat.recordRealWrite();
      }

      async function emitToken(content: string) {
        ensureStreamHealthy();
        try {
          await emitter.emitToken(content);
        } catch (error) {
          throw markTransportFailure(error);
        }
        heartbeat.recordRealWrite();
      }

      async function emitDone(data: {
        messageId: number;
        recalledAnchors: string[];
        shared_message_id?: string;
        content?: string;
      }) {
        ensureStreamHealthy();
        try {
          await emitter.emitDone(data);
        } catch (error) {
          throw markTransportFailure(error);
        }
        heartbeat.recordRealWrite();
      }

      async function emitError(code: string, message: string) {
        ensureStreamHealthy();
        try {
          await emitter.emitError(code, message);
        } catch (error) {
          throw markTransportFailure(error);
        }
        heartbeat.recordRealWrite();
      }

      const runReasoningFlow = async () => {
        await persistDirectMessage({
          connMgr,
          ownerPubKey,
          requesterPubKey,
          senderKey: requesterPubKey,
          senderKind: "owner",
          body: requestBody,
        });

        const conversationRows = listConversationRows(
          requesterConn.raw,
          parties,
          RUNTIME_CONVERSATION_WINDOW,
        )
          .slice(0, RUNTIME_CONVERSATION_WINDOW)
          .reverse();
        const request = await runtime.createRequest({
          avatarTarget: { publicKey: ownerPubKey },
          conversationTurns: mapConversationRowsToRuntimeMessages(
            conversationRows,
            requesterPubKey,
          ),
          initialAnchors: getAnchorsByIds(
            ownerConn,
            getCachedAnchorIds(requesterConn.raw, parties, ownerPubKey),
          ),
          stream: true,
          visitorKey: requesterPubKey,
        });
        const metadata = runtime.getPreparedReasoningMetadata(request);
        if (!metadata) {
          throw new Error("Prepared reasoning metadata missing");
        }

        for (const narrative of metadata.thinkingNarratives) {
          await emitThinking(narrative);
        }

        let fullContent = "";
        for await (const event of runtime.runStream(request)) {
          if (event.type === "message_start") {
            continue;
          }

          if (event.type === "text_delta") {
            fullContent += event.text;
            await emitToken(event.text);
          }
        }

        const savedAssistant = await persistDirectMessage({
          connMgr,
          ownerPubKey,
          requesterPubKey,
          senderKey: ownerPubKey,
          senderKind: "avatar",
          body: {
            type: "text",
            version: 1,
            text: fullContent,
            recalledAnchors: metadata.recalledAnchorIds,
            anchorSelectionStrategy: metadata.anchorSelectionStrategy,
          },
        });
        await emitDone({
          messageId: savedAssistant.localMessageId,
          shared_message_id: savedAssistant.sharedMessageId,
          content: fullContent,
          recalledAnchors: metadata.recalledAnchorIds,
        });
      };

      heartbeat.start();
      try {
        await Promise.race([runReasoningFlow(), heartbeat.failure]);
      } catch (error) {
        if (isTransportFailure(error)) {
          return;
        }

        try {
          await emitError("LLM_ERROR", error instanceof Error ? error.message : "Unknown error");
        } catch (emitErrorFailure) {
          if (isTransportFailure(emitErrorFailure)) {
            return;
          }
          throw emitErrorFailure;
        }
      } finally {
        heartbeat.stop();
      }
    });
  },
);

// POST /:pubKey/reasoning/messages/:sharedMessageId/read
reasoningRoutes.post(
  "/:pubKey/reasoning/messages/:sharedMessageId/read",
  zValidator("json", emptyBodySchema),
  async (c) => {
    const ownerPubKey = c.req.param("pubKey");
    const requesterPubKey = c.get("signerPubKey");
    const parties = buildConversationKeys(ownerPubKey, requesterPubKey);
    const slot = getPartySlot(parties, requesterPubKey);
    const updated = await applyReceiptToReplicas({
      connMgr: c.get("connMgr"),
      ownerPubKey,
      requesterPubKey,
      sharedMessageId: c.req.param("sharedMessageId"),
      patch: { slot, readAt: Date.now(), statusReason: null },
    });

    return c.json({ data: { shared_message_id: updated.shared_message_id } });
  },
);

// POST /:pubKey/reasoning/messages/:sharedMessageId/attest
reasoningRoutes.post(
  "/:pubKey/reasoning/messages/:sharedMessageId/attest",
  zValidator("json", attestSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "VALIDATION_ERROR", message: result.error.message }, 422);
    }
  }),
  async (c) => {
    const ownerPubKey = c.req.param("pubKey");
    const requesterPubKey = c.get("signerPubKey");
    const requesterConn = c.get("connMgr").getConnection(requesterPubKey, { create: true });
    const row = getDirectMessageBySharedId(requesterConn.raw, c.req.param("sharedMessageId"));

    if (!row) {
      return c.json({ error: "NOT_FOUND", message: "Message not found" }, 404);
    }

    const valid = await verifySignature(
      Buffer.from(row.message_hash, "hex"),
      c.req.valid("json").signature,
      requesterPubKey,
    );
    if (!valid) {
      return c.json({ error: "INVALID_SIGNATURE", message: "Attestation signature invalid" }, 422);
    }

    const slot = getPartySlot(buildConversationKeys(ownerPubKey, requesterPubKey), requesterPubKey);
    const updated = await applyReceiptToReplicas({
      connMgr: c.get("connMgr"),
      ownerPubKey,
      requesterPubKey,
      sharedMessageId: c.req.param("sharedMessageId"),
      patch: {
        slot,
        attestedAt: Date.now(),
        sign: c.req.valid("json").signature,
        statusReason: null,
      },
    });

    return c.json({ data: { shared_message_id: updated.shared_message_id } });
  },
);

// GET /:pubKey/reasoning/integrity
reasoningRoutes.get("/:pubKey/reasoning/integrity", (c) => {
  const ownerPubKey = c.req.param("pubKey");
  const requesterPubKey = c.get("signerPubKey");
  const parties = buildConversationKeys(ownerPubKey, requesterPubKey);
  const requesterConn = c.get("connMgr").getConnection(requesterPubKey, { create: true });
  const ownerConn = c.get("connMgr").getConnection(ownerPubKey, { create: true });
  const requesterRows = listConversationRows(requesterConn.raw, parties, 5000).slice(0, 5000);
  const ownerRows = listConversationRows(ownerConn.raw, parties, 5000).slice(0, 5000);
  const ownerBySharedId = new Map(ownerRows.map((row) => [row.shared_message_id, row]));
  const requesterIds = new Set(requesterRows.map((row) => row.shared_message_id));
  const ownerIds = new Set(ownerRows.map((row) => row.shared_message_id));

  let conflicts = 0;
  let tampered = 0;
  const chainBreaks = countChainBreaks(requesterRows) + countChainBreaks(ownerRows);

  for (const row of requesterRows) {
    const ownerRow = ownerBySharedId.get(row.shared_message_id) ?? null;
    if (ownerRow && ownerRow.message_hash !== row.message_hash) {
      conflicts += 1;
      continue;
    }

    if (validateStoredMessage(row).tampered) {
      tampered += 1;
    }
  }

  for (const row of ownerRows) {
    if (validateStoredMessage(row).tampered) {
      tampered += 1;
    }
  }

  for (const sharedMessageId of ownerIds) {
    if (!requesterIds.has(sharedMessageId)) {
      conflicts += 1;
    }
  }

  for (const sharedMessageId of requesterIds) {
    if (!ownerIds.has(sharedMessageId)) {
      conflicts += 1;
    }
  }
  const blocked = requesterRows.some(
    (row) => row.status_reason_a === BLOCKED_REASON || row.status_reason_b === BLOCKED_REASON,
  );
  const status =
    conflicts > 0 || chainBreaks > 0
      ? "conflicted"
      : tampered > 0
        ? "tampered"
        : blocked
          ? "blocked"
          : "healthy";

  return c.json({ data: { status, blocked, conflicts, tampered, chain_breaks: chainBreaks } });
});
