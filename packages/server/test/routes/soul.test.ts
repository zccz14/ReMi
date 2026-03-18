import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { soulRoutes } from "../../src/routes/soul.js";
import { ConnectionManager } from "../../src/db/connection.js";
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

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `remi-soul-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    connMgr = new ConnectionManager(tmpDir, { maxSize: 10, embeddingDimensions: 4 });
    connMgr.getConnection(PUB_KEY, { create: true });
  });

  afterEach(() => {
    connMgr.closeAll();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
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
      body: JSON.stringify({ targetPubKey: "newKey456" }),
    });
    expect(res.status).toBe(201);
    expect(fs.existsSync(path.join(tmpDir, "newKey456.sqlite"))).toBe(true);
    // Original file still exists
    expect(fs.existsSync(path.join(tmpDir, `${PUB_KEY}.sqlite`))).toBe(true);
  });

  it("POST /api/:pubKey/copy → 409 if target exists", async () => {
    connMgr.getConnection("existingKey", { create: true });
    const app = createTestApp(connMgr, PUB_KEY);
    const res = await app.request(`/api/${PUB_KEY}/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetPubKey: "existingKey" }),
    });
    expect(res.status).toBe(409);
  });

  it("visitor cannot delete soul → 403", async () => {
    const app = createTestApp(connMgr, "visitorKey");
    const res = await app.request(`/api/${PUB_KEY}`, { method: "DELETE" });
    expect(res.status).toBe(403);
  });
});
