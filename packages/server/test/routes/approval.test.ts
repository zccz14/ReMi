import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { approvalRoutes } from "../../src/routes/approval.js";
import { ConnectionManager } from "../../src/db/connection.js";
import { createApprovalService } from "../../src/approval/service.js";
import type { EmbeddingClient } from "../../src/embedding/client.js";

function createTestApp(
  connMgr: ConnectionManager,
  pubKey: string,
  embeddingClient: EmbeddingClient | null = null,
) {
  const app = new Hono();
  app.use("/api/:pubKey/*", async (c, next) => {
    c.set("signerPubKey", pubKey);
    c.set("role", pubKey === c.req.param("pubKey") ? "owner" : "visitor");
    c.set("connMgr", connMgr);
    c.set("embeddingClient", embeddingClient);
    await next();
  });
  app.route("/api", approvalRoutes);
  return app;
}

describe("approval routes", () => {
  let tmpDir: string;
  let connMgr: ConnectionManager;
  const PUB_KEY = "testOwnerPubKey123";

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `remi-approval-route-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    connMgr = new ConnectionManager(tmpDir, { maxSize: 10, embeddingDimensions: 4 });
    connMgr.getConnection(PUB_KEY, { create: true });
  });

  afterEach(() => {
    connMgr.closeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("POST /api/:pubKey/approval/candidates creates a candidate with provenance", async () => {
    const app = createTestApp(connMgr, PUB_KEY);

    const res = await app.request(`/api/${PUB_KEY}/approval/candidates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "What matters most?",
        answer: "Trust",
        source: "reading",
        sourceRef: "reading-round-1",
        sourceSnapshot: { excerpt: "Trust matters most." },
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data).toEqual(
      expect.objectContaining({
        question: "What matters most?",
        answer: "Trust",
        source: "reading",
        sourceRef: "reading-round-1",
        kind: "anchor",
      }),
    );
    expect(json.data.sourceSnapshot).toContain("Trust matters most.");
  });

  it("GET /api/:pubKey/approval/candidates filters anchor and probe queues", async () => {
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    service.createCandidate({
      question: "Anchor question",
      answer: "Anchor answer",
      source: "manual",
    });
    service.createCandidate({ question: "Probe question", answer: null, source: "interview" });
    const app = createTestApp(connMgr, PUB_KEY);

    const anchorRes = await app.request(`/api/${PUB_KEY}/approval/candidates?kind=anchor`);
    expect(anchorRes.status).toBe(200);
    const anchorJson = await anchorRes.json();
    expect(anchorJson.data.items).toHaveLength(1);
    expect(anchorJson.data.items[0]).toEqual(expect.objectContaining({ kind: "anchor" }));

    const probeRes = await app.request(`/api/${PUB_KEY}/approval/candidates?kind=probe`);
    expect(probeRes.status).toBe(200);
    const probeJson = await probeRes.json();
    expect(probeJson.data.items).toHaveLength(1);
    expect(probeJson.data.items[0]).toEqual(
      expect.objectContaining({ kind: "probe", answer: null, source: "interview" }),
    );
  });

  it("POST /api/:pubKey/approval/candidates/:id/approve requires requestId", async () => {
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    const candidate = service.createCandidate({
      question: "Anchor question",
      answer: "Anchor answer",
      source: "manual",
    });
    const app = createTestApp(connMgr, PUB_KEY);

    const res = await app.request(`/api/${PUB_KEY}/approval/candidates/${candidate.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "create_new" }),
    });

    expect(res.status).toBe(400);
  });

  it("POST /api/:pubKey/approval/candidates/:id/approve returns 409 for already processed candidates", async () => {
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    const candidate = service.createCandidate({
      question: "Anchor question",
      answer: "Anchor answer",
      source: "manual",
    });
    await service.approveCandidate({
      candidateId: candidate.id,
      action: "approve",
      mode: "create_new",
      requestId: "req-initial-approve",
    });
    const app = createTestApp(connMgr, PUB_KEY);

    const res = await app.request(`/api/${PUB_KEY}/approval/candidates/${candidate.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-second-approve", mode: "create_new" }),
    });

    expect(res.status).toBe(409);
  });

  it("POST /api/:pubKey/approval/candidates/:id/approve returns 409 on stale target updates", async () => {
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    const existing = await service.microEditAsset({
      assetId: null,
      question: "Existing question",
      answer: "Existing answer",
      source: "manual",
      requestId: "seed-existing-asset",
    });
    const candidate = service.createCandidate({
      question: "Updated question",
      answer: "Updated answer",
      source: "reading",
    });
    const app = createTestApp(connMgr, PUB_KEY);

    const res = await app.request(`/api/${PUB_KEY}/approval/candidates/${candidate.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-stale-update",
        mode: "update_existing",
        targetAssetId: existing.asset.id,
        targetUpdatedAt: existing.asset.updatedAt - 1,
      }),
    });

    expect(res.status).toBe(409);
  });

  it("POST /api/:pubKey/approval/candidates/:id/reject rejects the candidate", async () => {
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    const candidate = service.createCandidate({
      question: "Reject me",
      answer: "Nope",
      source: "manual",
    });
    const app = createTestApp(connMgr, PUB_KEY);

    const res = await app.request(`/api/${PUB_KEY}/approval/candidates/${candidate.id}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-reject-route" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.asset).toBeNull();
  });

  it("POST /api/:pubKey/approval/candidates/:id/skip skips a probe without formal write", async () => {
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    const candidate = service.createCandidate({
      question: "Ask later",
      answer: null,
      source: "interview",
    });
    const app = createTestApp(connMgr, PUB_KEY);

    const res = await app.request(`/api/${PUB_KEY}/approval/candidates/${candidate.id}/skip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-skip-route" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.asset).toBeNull();
  });

  it("POST /api/:pubKey/approval/undo restores the last candidate", async () => {
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    const candidate = service.createCandidate({
      question: "Undo me",
      answer: "Later",
      source: "manual",
    });
    const rejected = await service.approveCandidate({
      candidateId: candidate.id,
      action: "reject",
      mode: "create_new",
      requestId: "req-pre-undo",
    });
    const app = createTestApp(connMgr, PUB_KEY);

    const res = await app.request(`/api/${PUB_KEY}/approval/undo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionId: rejected.actionId }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.restoredCandidate).toEqual(expect.objectContaining({ id: candidate.id }));
  });

  it("POST /api/:pubKey/approval/undo returns 409 when target changed", async () => {
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    const created = await service.microEditAsset({
      assetId: null,
      question: "Question",
      answer: "Answer",
      source: "manual",
      requestId: "seed-undo-conflict",
    });
    const denied = await service.denyAsset({
      assetId: created.asset.id,
      requestId: "deny-for-undo-conflict",
    });
    conn.raw
      .prepare(
        "UPDATE soul_anchors SET question = ?, answer = ?, updated_at = updated_at + 1 WHERE id = ?",
      )
      .run("Question changed", "Answer changed", created.asset.id);
    const app = createTestApp(connMgr, PUB_KEY);

    const res = await app.request(`/api/${PUB_KEY}/approval/undo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionId: denied.actionId }),
    });

    expect(res.status).toBe(409);
  });

  it("PUT /api/:pubKey/anchors/:id updates via gateway and requires requestId", async () => {
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    const created = await service.microEditAsset({
      assetId: null,
      question: "Question",
      answer: "Answer",
      source: "manual",
      requestId: "seed-edit-asset",
    });
    const app = createTestApp(connMgr, PUB_KEY);

    const missingRequestId = await app.request(`/api/${PUB_KEY}/anchors/${created.asset.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "Edited question",
        answer: "Edited answer",
        source: "manual",
      }),
    });
    expect(missingRequestId.status).toBe(400);

    const res = await app.request(`/api/${PUB_KEY}/anchors/${created.asset.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-edit-route",
        question: "Edited question",
        answer: "Edited answer",
        source: "manual",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.asset).toEqual(expect.objectContaining({ question: "Edited question" }));
  });

  it("POST /api/:pubKey/anchors/:id/deny denies formal asset and returns 404 when missing", async () => {
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    const created = await service.microEditAsset({
      assetId: null,
      question: "Question",
      answer: "Answer",
      source: "reading",
      requestId: "seed-deny-asset-route",
    });
    const app = createTestApp(connMgr, PUB_KEY);

    const denyRes = await app.request(`/api/${PUB_KEY}/anchors/${created.asset.id}/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-deny-route" }),
    });

    expect(denyRes.status).toBe(200);
    const denyJson = await denyRes.json();
    expect(denyJson.data.asset).toEqual(
      expect.objectContaining({ answer: null, source: "reading" }),
    );

    const missingRes = await app.request(`/api/${PUB_KEY}/anchors/missing-asset/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-deny-missing" }),
    });

    expect(missingRes.status).toBe(404);
  });
});
