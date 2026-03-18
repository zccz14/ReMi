import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { anchorRoutes } from "../../src/routes/anchors.js";
import { ConnectionManager } from "../../src/db/connection.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Test app: skip real auth, directly inject signerPubKey and role
function createTestApp(connMgr: ConnectionManager, pubKey: string) {
  const app = new Hono();
  // Mock auth + role middleware
  app.use("/api/:pubKey/*", async (c, next) => {
    c.set("signerPubKey", pubKey);
    c.set("role", pubKey === c.req.param("pubKey") ? "owner" : "visitor");
    c.set("connMgr", connMgr);
    await next();
  });
  app.route("/api", anchorRoutes);
  return app;
}

describe("anchor routes", () => {
  let tmpDir: string;
  let connMgr: ConnectionManager;
  const PUB_KEY = "testOwnerPubKey123";

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `remi-route-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    connMgr = new ConnectionManager(tmpDir, { maxSize: 10, embeddingDimensions: 4 });
    // Pre-create soul
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

  it("POST /api/:pubKey/anchors → 201 creates anchor", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const res = await app.request(`/api/${PUB_KEY}/anchors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "测试问题", source: "manual" }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.question).toBe("测试问题");
    expect(json.data.answer).toBeNull();
    expect(json.data.id).toBeTruthy();
  });

  it("GET /api/:pubKey/anchors → 200 lists anchors", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    // Create one first
    await app.request(`/api/${PUB_KEY}/anchors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Q1", source: "manual" }),
    });
    const res = await app.request(`/api/${PUB_KEY}/anchors`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.items).toHaveLength(1);
    expect(json.data.total).toBe(1);
  });

  it("PUT /api/:pubKey/anchors/:id → 200 updates anchor", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const createRes = await app.request(`/api/${PUB_KEY}/anchors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Q1", source: "manual" }),
    });
    const { data: created } = await createRes.json();

    const res = await app.request(`/api/${PUB_KEY}/anchors/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "A1" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.answer).toBe("A1");
  });

  it("DELETE /api/:pubKey/anchors/:id → 204", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const createRes = await app.request(`/api/${PUB_KEY}/anchors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Q1", source: "manual" }),
    });
    const { data: created } = await createRes.json();

    const res = await app.request(`/api/${PUB_KEY}/anchors/${created.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
  });

  it("DELETE /api/:pubKey/anchors → 204 clears all", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    await app.request(`/api/${PUB_KEY}/anchors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Q1", source: "manual" }),
    });
    const res = await app.request(`/api/${PUB_KEY}/anchors`, { method: "DELETE" });
    expect(res.status).toBe(204);

    // Confirm cleared
    const listRes = await app.request(`/api/${PUB_KEY}/anchors`);
    const json = await listRes.json();
    expect(json.data.total).toBe(0);
  });

  it("visitor should be rejected with 403", async () => {
    const app = createTestApp(connMgr, "differentPubKey");
    const res = await app.request(`/api/${PUB_KEY}/anchors`);
    expect(res.status).toBe(403);
  });
});
