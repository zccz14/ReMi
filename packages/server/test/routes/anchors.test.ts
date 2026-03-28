import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { anchorRoutes } from "../../src/routes/anchors.js";
import { approvalRoutes } from "../../src/routes/approval.js";
import { ConnectionManager } from "../../src/db/connection.js";
import { createApprovalService } from "../../src/approval/service.js";
import { subscribeToLogs, type StructuredLogRecord } from "../../src/logger.js";
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

function captureLogs() {
  const records: StructuredLogRecord[] = [];
  const unsubscribe = subscribeToLogs((record) => {
    records.push(record);
  });
  return { records, unsubscribe };
}

function findEvents(records: StructuredLogRecord[], event: string) {
  return records.filter((record) => record.event === event || record.alertType === event);
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
    expect(json.data.kind).toBe("probe");
    expect(json.data.id).toBeTruthy();

    const listRes = await app.request(`/api/${PUB_KEY}/anchors`);
    const listJson = await listRes.json();
    expect(listJson.data.total).toBe(0);
  });

  it("GET /api/:pubKey/anchors → 200 lists anchors", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    await service.microEditAsset({
      assetId: null,
      question: "Q1",
      answer: "A1",
      source: "manual",
      requestId: "seed-list-anchor",
    });
    const res = await app.request(`/api/${PUB_KEY}/anchors`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.items).toHaveLength(1);
    expect(json.data.total).toBe(1);
  });

  it("GET /api/:pubKey/anchors orders by updatedAt desc after edits", async () => {
    const dateNowMock = vi.spyOn(Date, "now");
    let currentTime = 1000;
    dateNowMock.mockImplementation(() => currentTime);

    try {
      const app = createTestApp(connMgr, PUB_KEY);
      const conn = connMgr.getConnection(PUB_KEY);
      const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });

      const olderRes = await service.microEditAsset({
        assetId: null,
        question: "Older",
        answer: null,
        source: "manual",
        requestId: "seed-older-anchor",
      });

      currentTime = 2000;
      const newerRes = await service.microEditAsset({
        assetId: null,
        question: "Newer",
        answer: null,
        source: "manual",
        requestId: "seed-newer-anchor",
      });

      const olderAnchor = olderRes.asset;
      const newerAnchor = newerRes.asset;

      expect(olderAnchor.question).toBe("Older");
      expect(newerAnchor.question).toBe("Newer");
      expect(olderAnchor.createdAt).toBe(1000);
      expect(newerAnchor.createdAt).toBe(2000);

      currentTime = 3000;
      const updateRes = await app.request(`/api/${PUB_KEY}/anchors/${olderAnchor.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "route-edit-ordering", answer: "edited later" }),
      });
      expect(updateRes.status).toBe(200);
      const updatedJson = await updateRes.json();
      expect(updatedJson.data.asset.updatedAt).toBe(3000);

      const res = await app.request(`/api/${PUB_KEY}/anchors`);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.data.items.map((item: { question: string }) => item.question)).toEqual([
        "Older",
        "Newer",
      ]);
    } finally {
      dateNowMock.mockRestore();
    }
  });

  it("GET /api/:pubKey/anchors sanitizes invalid limit and offset", async () => {
    const app = createTestApp(connMgr, PUB_KEY);

    const res = await app.request(`/api/${PUB_KEY}/anchors?limit=NaN&offset=-5`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.limit).toBe(50);
    expect(json.data.offset).toBe(0);
    expect(json.data.items).toEqual([]);
    expect(json.data.total).toBe(0);
  });

  it("GET /api/:pubKey/anchors round-trips reading provenance", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const conn = connMgr.getConnection(PUB_KEY);

    conn.raw
      .prepare(
        `INSERT INTO soul_anchors (id, question, answer, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("reading-anchor", "Read question", "Read answer", "reading", 1000, 1000);

    const res = await app.request(`/api/${PUB_KEY}/anchors`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.items).toEqual([
      expect.objectContaining({
        id: "reading-anchor",
        source: "reading",
      }),
    ]);
  });

  it("PUT /api/:pubKey/anchors/:id → 200 updates anchor", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    const created = await service.microEditAsset({
      assetId: null,
      question: "Q1",
      answer: null,
      source: "manual",
      requestId: "seed-put-anchor",
    });

    const missingRequestIdRes = await app.request(`/api/${PUB_KEY}/anchors/${created.asset.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "A1", source: "manual", question: "Q1" }),
    });
    expect(missingRequestIdRes.status).toBe(400);

    const res = await app.request(`/api/${PUB_KEY}/anchors/${created.asset.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "route-put-anchor",
        question: "Q1",
        answer: "A1",
        source: "manual",
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.asset.answer).toBe("A1");
  });

  it("records micro-edit writes with requestId and null-safe fields", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    const created = await service.microEditAsset({
      assetId: null,
      question: "Q1",
      answer: null,
      source: "reading",
      requestId: "seed-micro-edit-log",
    });
    const { records, unsubscribe } = captureLogs();

    try {
      const res = await app.request(`/api/${PUB_KEY}/anchors/${created.asset.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "route-micro-edit-log", answer: "A1" }),
      });

      expect(res.status).toBe(200);
      expect(findEvents(records, "formal_asset_written")[0]).toEqual(
        expect.objectContaining({
          ownerKey: PUB_KEY,
          assetId: created.asset.id,
          candidateId: null,
          requestId: "route-micro-edit-log",
          actionType: "micro_edit",
          gateway: "controlled_write_service",
        }),
      );
    } finally {
      unsubscribe();
    }
  });

  it("PUT /api/:pubKey/anchors/:id prefers anchor route when approval routes mount first", async () => {
    const app = new Hono();
    app.use("/api/:pubKey/*", async (c, next) => {
      c.set("signerPubKey", PUB_KEY);
      c.set("role", PUB_KEY === c.req.param("pubKey") ? "owner" : "visitor");
      c.set("connMgr", connMgr);
      c.set("embeddingClient", null);
      await next();
    });
    app.route("/api", approvalRoutes);
    app.route("/api", anchorRoutes);

    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    const created = await service.microEditAsset({
      assetId: null,
      question: "Q1",
      answer: "A1",
      source: "manual",
      requestId: "seed-shadow-anchor",
    });

    const res = await app.request(`/api/${PUB_KEY}/anchors/${created.asset.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "route-shadow-anchor", answer: "A2" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.asset).toEqual(expect.objectContaining({ question: "Q1", answer: "A2" }));
  });

  it("POST /api/:pubKey/anchors/:id/deny routes through gateway", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    const created = await service.microEditAsset({
      assetId: null,
      question: "Q1",
      answer: "A1",
      source: "reading",
      requestId: "seed-deny-anchor",
    });

    const res = await app.request(`/api/${PUB_KEY}/anchors/${created.asset.id}/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "route-deny-anchor" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.asset.answer).toBeNull();
  });

  it("records deny writes with requestId and candidateId=null", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    const created = await service.microEditAsset({
      assetId: null,
      question: "Q1",
      answer: "A1",
      source: "reading",
      requestId: "seed-deny-log",
    });
    const { records, unsubscribe } = captureLogs();

    try {
      const res = await app.request(`/api/${PUB_KEY}/anchors/${created.asset.id}/deny`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "route-deny-log" }),
      });

      expect(res.status).toBe(200);
      expect(findEvents(records, "formal_asset_written")[0]).toEqual(
        expect.objectContaining({
          ownerKey: PUB_KEY,
          assetId: created.asset.id,
          candidateId: null,
          requestId: "route-deny-log",
          actionType: "deny",
          gateway: "controlled_write_service",
        }),
      );
    } finally {
      unsubscribe();
    }
  });

  it("DELETE /api/:pubKey/anchors/:id → 405 legacy delete path disabled", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    const created = await service.microEditAsset({
      assetId: null,
      question: "Q1",
      answer: null,
      source: "manual",
      requestId: "seed-delete-anchor",
    });

    const res = await app.request(`/api/${PUB_KEY}/anchors/${created.asset.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(405);

    const listRes = await app.request(`/api/${PUB_KEY}/anchors`);
    const listJson = await listRes.json();
    expect(listJson.data.items).toEqual([expect.objectContaining({ id: created.asset.id })]);
  });

  it("emits direct_write_blocked for legacy single delete attempts", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    const created = await service.microEditAsset({
      assetId: null,
      question: "Q1",
      answer: null,
      source: "manual",
      requestId: "seed-delete-alert",
    });
    const { records, unsubscribe } = captureLogs();

    try {
      const res = await app.request(`/api/${PUB_KEY}/anchors/${created.asset.id}`, {
        method: "DELETE",
      });

      expect(res.status).toBe(405);
      expect(findEvents(records, "direct_write_blocked")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            alertType: "direct_write_blocked",
            ownerKey: PUB_KEY,
            routeOrModule: "routes/anchors",
            attemptedAction: "DELETE /:pubKey/anchors/:id",
          }),
        ]),
      );
    } finally {
      unsubscribe();
    }
  });

  it("DELETE /api/:pubKey/anchors → 405 legacy delete path disabled", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    await service.microEditAsset({
      assetId: null,
      question: "Q1",
      answer: null,
      source: "manual",
      requestId: "seed-clear-anchor",
    });
    const res = await app.request(`/api/${PUB_KEY}/anchors`, { method: "DELETE" });
    expect(res.status).toBe(405);

    // Confirm untouched
    const listRes = await app.request(`/api/${PUB_KEY}/anchors`);
    const json = await listRes.json();
    expect(json.data.total).toBe(1);
  });

  it("visitor should be rejected with 403", async () => {
    const app = createTestApp(connMgr, "differentPubKey");
    const res = await app.request(`/api/${PUB_KEY}/anchors`);
    expect(res.status).toBe(403);
  });
});
