import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";

import { ConnectionManager } from "../../src/db/connection.js";
import { conversationRoutes } from "../../src/routes/conversations.js";

let tmpDir: string;
let connMgr: ConnectionManager;

const ownerPubKey = "owner-pub-key";
const peerOnePubKey = "peer-one-pub-key";
const peerTwoPubKey = "peer-two-pub-key";

function createTestApp(signerPubKey: string) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("signerPubKey", signerPubKey);
    c.set("role", signerPubKey === ownerPubKey ? "owner" : "visitor");
    c.set("connMgr", connMgr);
    await next();
  });
  app.route("/api", conversationRoutes);
  return app;
}

function getOwnerConn() {
  return connMgr.getConnection(ownerPubKey, { create: true });
}

function seedInterviewMessage(content: string, createdAt: number) {
  getOwnerConn()
    .raw.prepare(`INSERT INTO messages (role, content, created_at) VALUES ('assistant', ?, ?)`)
    .run(content, createdAt);
}

function seedDirectMessage(options: {
  partyAKey: string;
  partyBKey: string;
  senderKey: string;
  ciphertextC: string;
  createdAt: number;
}) {
  getOwnerConn()
    .raw.prepare(
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
        created_at
      ) VALUES (?, ?, ?, ?, 'owner', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      options.partyAKey,
      options.partyBKey,
      options.senderKey,
      "ciphertext-a",
      "ciphertext-b",
      options.ciphertextC,
      crypto.randomUUID().split("-").join(""),
      null,
      options.createdAt,
    );
}

function encodePreviewBody(text: string): string {
  return Buffer.from(JSON.stringify({ type: "text", version: 1, text }), "utf8").toString("base64");
}

describe("conversation routes", () => {
  beforeEach(() => {
    tmpDir = path.join("test-tmp", `conversation-routes-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    connMgr = new ConnectionManager(tmpDir, {
      maxSize: 10,
      embeddingDimensions: 4,
    });
    connMgr.getConnection(ownerPubKey, { create: true });
  });

  afterEach(() => {
    connMgr.closeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /conversations aggregates the latest direct_messages preview per peer", async () => {
    seedInterviewMessage("ReMi latest", 175);
    seedDirectMessage({
      partyAKey: ownerPubKey,
      partyBKey: peerOnePubKey,
      senderKey: ownerPubKey,
      ciphertextC: encodePreviewBody("peer one old"),
      createdAt: 100,
    });
    seedDirectMessage({
      partyAKey: ownerPubKey,
      partyBKey: peerTwoPubKey,
      senderKey: peerTwoPubKey,
      ciphertextC: encodePreviewBody("peer two latest"),
      createdAt: 150,
    });
    seedDirectMessage({
      partyAKey: ownerPubKey,
      partyBKey: peerOnePubKey,
      senderKey: peerOnePubKey,
      ciphertextC: encodePreviewBody("peer one latest"),
      createdAt: 200,
    });

    const app = createTestApp(ownerPubKey);
    const res = await app.request(`/api/${ownerPubKey}/conversations`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      data: [
        {
          type: "avatar",
          pubKey: peerOnePubKey,
          lastMessage: "peer one latest",
          lastMessageAt: 200,
        },
        {
          type: "remi",
          lastMessage: "ReMi latest",
          lastMessageAt: 175,
        },
        {
          type: "avatar",
          pubKey: peerTwoPubKey,
          lastMessage: "peer two latest",
          lastMessageAt: 150,
        },
      ],
    });
  });

  it("GET /contacts aggregates peer keys from direct_messages instead of reasoning_messages", async () => {
    const conn = getOwnerConn().raw;
    conn.exec(
      `CREATE TABLE reasoning_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        visitor_key TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    conn
      .prepare(
        `INSERT INTO reasoning_messages (visitor_key, role, content, created_at) VALUES (?, 'assistant', 'legacy', ?)`,
      )
      .run("legacy-visitor", 999);

    seedDirectMessage({
      partyAKey: ownerPubKey,
      partyBKey: peerOnePubKey,
      senderKey: ownerPubKey,
      ciphertextC: encodePreviewBody("hello one"),
      createdAt: 100,
    });
    seedDirectMessage({
      partyAKey: ownerPubKey,
      partyBKey: peerTwoPubKey,
      senderKey: peerTwoPubKey,
      ciphertextC: encodePreviewBody("hello two"),
      createdAt: 200,
    });
    seedDirectMessage({
      partyAKey: ownerPubKey,
      partyBKey: peerOnePubKey,
      senderKey: peerOnePubKey,
      ciphertextC: encodePreviewBody("hello again"),
      createdAt: 300,
    });

    const app = createTestApp(ownerPubKey);
    const res = await app.request(`/api/${ownerPubKey}/contacts`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      data: [{ pubKey: peerOnePubKey }, { pubKey: peerTwoPubKey }],
    });
  });
});
