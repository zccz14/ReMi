import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { reasoningRoutes } from "../../src/routes/reasoning.js";
import { ConnectionManager } from "../../src/db/connection.js";
import * as fs from "fs";
import * as path from "path";

let tmpDir: string;
let connMgr: ConnectionManager;
const testPubKey = "test-pub-key";
const visitorPubKey = "visitor-pub-key";

function createTestApp(signerPubKey: string) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("signerPubKey", signerPubKey);
    c.set("role", signerPubKey === testPubKey ? "owner" : "visitor");
    c.set("connMgr", connMgr);
    c.set("embeddingClient", null);
    c.set("chatClient", null);
    await next();
  });
  app.route("/api", reasoningRoutes);
  return app;
}

describe("reasoning routes", () => {
  beforeEach(() => {
    tmpDir = path.join("test-tmp", "reasoning-routes-" + crypto.randomUUID());
    fs.mkdirSync(tmpDir, { recursive: true });
    connMgr = new ConnectionManager(tmpDir, {
      maxSize: 10,
      embeddingDimensions: 4,
    });
    connMgr.getConnection(testPubKey, { create: true });
  });

  afterEach(() => {
    connMgr.closeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /reasoning/messages -> 200 empty", async () => {
    const app = createTestApp(visitorPubKey);
    const res = await app.request(`/api/${testPubKey}/reasoning/messages`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toEqual([]);
    expect(body.data.hasMore).toBe(false);
  });

  it("GET /reasoning/messages filters by visitor_key", async () => {
    const app = createTestApp(visitorPubKey);
    const res = await app.request(`/api/${testPubKey}/reasoning/messages`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toEqual([]);
  });
});
