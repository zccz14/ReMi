import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { soulRoutes } from "../../src/routes/soul.js";
import * as soulModule from "../../src/routes/soul.js";
import { ConnectionManager } from "../../src/db/connection.js";
import { PROFILE_ID } from "../../src/routes/profile.js";
import { createApp } from "../../src/app.js";
import { base58Encode, buildStringToSign, generateKeyPair, getPublicKey, sign } from "@remi/crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function createTestApp(connMgr: ConnectionManager, signerKey: string) {
  const app = new Hono();
  app.use("/api/:pubKey/*", async (c, next) => {
    c.set("signerPubKey", signerKey);
    c.set("role", signerKey === c.req.param("pubKey") ? "owner" : "visitor");
    c.set("connMgr", connMgr);
    await next();
  });
  // soul routes DELETE /api/:pubKey has no wildcard tail, handle separately
  app.use("/api/:pubKey", async (c, next) => {
    c.set("signerPubKey", signerKey);
    c.set("role", signerKey === c.req.param("pubKey") ? "owner" : "visitor");
    c.set("connMgr", connMgr);
    await next();
  });
  app.route("/api", soulRoutes);
  return app;
}

describe("soul routes", () => {
  let tmpDir: string;
  let connMgr: ConnectionManager;
  const PUB_KEY = "ownerKey123";
  const COPY_TARGET_KEY = getPublicKey(generateKeyPair());
  const EXISTING_TARGET_KEY = getPublicKey(generateKeyPair());
  const PROFILE_TARGET_KEY = getPublicKey(generateKeyPair());

  function seedProfileAndAvatar(pubKey: string) {
    const now = Date.now();
    const conn = connMgr.getConnection(pubKey, { create: true });
    conn.raw
      .prepare(
        `INSERT INTO public_profile (id, display_name, bio, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(PROFILE_ID, "Owner Name", "Owner Bio", now);
    conn.raw
      .prepare(
        `INSERT INTO public_profile_avatar (id, blob, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(PROFILE_ID, Buffer.from([1, 2, 3]), now);
  }

  function readPublicProfile(pubKey: string) {
    const conn = connMgr.getConnection(pubKey, { create: false });
    const profile = conn.raw
      .prepare("SELECT display_name AS displayName FROM public_profile WHERE id = ?")
      .get(PROFILE_ID) as { displayName: string | null } | undefined;
    const avatar = conn.raw
      .prepare("SELECT updated_at AS updatedAt FROM public_profile_avatar WHERE id = ?")
      .get(PROFILE_ID) as { updatedAt: number } | undefined;

    return {
      displayName: profile?.displayName ?? "",
      hasAvatar: Boolean(avatar),
    };
  }

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `remi-soul-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    connMgr = new ConnectionManager(tmpDir, { maxSize: 10, embeddingDimensions: 4 });
    connMgr.getConnection(PUB_KEY, { create: true });
  });

  afterEach(() => {
    connMgr.closeAll();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it("DELETE /api/:pubKey → 204 deletes soul file", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const res = await app.request(`/api/${PUB_KEY}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(fs.existsSync(path.join(tmpDir, `${PUB_KEY}.sqlite`))).toBe(false);
  });

  it("DELETE /api/:pubKey → 204 idempotent", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    await app.request(`/api/${PUB_KEY}`, { method: "DELETE" });
    const res = await app.request(`/api/${PUB_KEY}`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  it("POST /api/:pubKey/copy → 201 copies soul", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const res = await app.request(`/api/${PUB_KEY}/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetPubKey: COPY_TARGET_KEY }),
    });
    expect(res.status).toBe(201);
    expect(fs.existsSync(path.join(tmpDir, `${COPY_TARGET_KEY}.sqlite`))).toBe(true);
    // Original file still exists
    expect(fs.existsSync(path.join(tmpDir, `${PUB_KEY}.sqlite`))).toBe(true);
  });

  it("POST /api/:pubKey/copy → 409 if target exists", async () => {
    connMgr.getConnection(EXISTING_TARGET_KEY, { create: true });
    const app = createTestApp(connMgr, PUB_KEY);
    const res = await app.request(`/api/${PUB_KEY}/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetPubKey: EXISTING_TARGET_KEY }),
    });
    expect(res.status).toBe(409);
  });

  it("POST /api/:pubKey/copy clears copied public profile and avatar rows", async () => {
    seedProfileAndAvatar(PUB_KEY);

    const app = createTestApp(connMgr, PUB_KEY);
    const res = await app.request(`/api/${PUB_KEY}/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetPubKey: PROFILE_TARGET_KEY }),
    });

    expect(res.status).toBe(201);
    expect(readPublicProfile(PROFILE_TARGET_KEY)).toMatchObject({
      displayName: "",
      hasAvatar: false,
    });
  });

  it("POST /api/:pubKey/copy rejects targetPubKey values with the wrong decoded length", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const wrongLengthTargetPubKey = base58Encode(new Uint8Array(31).fill(5));

    const res = await app.request(`/api/${PUB_KEY}/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetPubKey: wrongLengthTargetPubKey }),
    });

    expect(res.status).toBe(422);
  });

  it("POST /api/:pubKey/copy fails when source soul did not exist before the request", async () => {
    const missingPrivKey = generateKeyPair();
    const missingPubKey = getPublicKey(missingPrivKey);
    const { app, connMgr: appConnMgr } = createApp({ dataDir: tmpDir, embeddingDimensions: 4 });

    const timestamp = String(Date.now());
    const body = JSON.stringify({ targetPubKey: getPublicKey(generateKeyPair()) });
    const bodyBytes = new TextEncoder().encode(body);
    const stringToSign = await buildStringToSign(
      "POST",
      `/api/${missingPubKey}/copy`,
      timestamp,
      bodyBytes,
    );
    const signature = await sign(new TextEncoder().encode(stringToSign), missingPrivKey);

    const res = await app.request(`/api/${missingPubKey}/copy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Public-Key": missingPubKey,
        "X-Timestamp": timestamp,
        "X-Signature": signature,
      },
      body,
    });

    expect(res.status).toBe(404);
    expect(fs.existsSync(path.join(tmpDir, `${missingPubKey}.sqlite`))).toBe(false);
    appConnMgr.closeAll();
  });

  it("maps copy destination race errors to 409", () => {
    const copyError = Object.assign(new Error("exists"), { code: "EEXIST" });
    expect(soulModule.mapCopySoulError(copyError)).toBe(409);
  });

  it("maps copy missing-source errors to 404", () => {
    const copyError = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(soulModule.mapCopySoulError(copyError)).toBe(404);
  });

  it("visitor cannot delete soul → 403", async () => {
    const app = createTestApp(connMgr, "visitorKey");
    const res = await app.request(`/api/${PUB_KEY}`, { method: "DELETE" });
    expect(res.status).toBe(403);
  });
});
