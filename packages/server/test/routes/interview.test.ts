import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { interviewRoutes } from "../../src/routes/interview.js";
import { ConnectionManager } from "../../src/db/connection.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function createTestApp(connMgr: ConnectionManager, pubKey: string) {
  const app = new Hono();
  app.use("/api/:pubKey/*", async (c, next) => {
    c.set("signerPubKey", pubKey);
    c.set("role", pubKey === c.req.param("pubKey") ? "owner" : "visitor");
    c.set("connMgr", connMgr);
    c.set("embeddingClient", null);
    c.set("chatClient", null);
    await next();
  });
  app.route("/api", interviewRoutes);
  return app;
}

describe("interview routes", () => {
  let tmpDir: string;
  let connMgr: ConnectionManager;
  const PUB_KEY = "testOwnerPubKey123";

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `remi-interview-test-${crypto.randomUUID()}`);
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

  it("GET /api/:pubKey/interview/status → 200 returns stats", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const res = await app.request(`/api/${PUB_KEY}/interview/status`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.totalAnchors).toBe(0);
    expect(json.data.totalMessages).toBe(0);
    expect(json.data.lastActiveAt).toBeNull();
  });

  it("GET /api/:pubKey/interview/messages → 200 returns empty list", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const res = await app.request(`/api/${PUB_KEY}/interview/messages`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.items).toHaveLength(0);
    expect(json.data.hasMore).toBe(false);
  });

  it("visitor should be rejected with 403", async () => {
    const app = createTestApp(connMgr, "differentPubKey");
    const res = await app.request(`/api/${PUB_KEY}/interview/status`);
    expect(res.status).toBe(403);
  });
});
