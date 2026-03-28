import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { approvalRoutes } from "../../src/routes/approval.js";
import { buildApprovalAlert } from "../../src/approval/alerts.js";
import { ConnectionManager } from "../../src/db/connection.js";
import { createApprovalService } from "../../src/approval/service.js";
import type { EmbeddingClient } from "../../src/embedding/client.js";
import { subscribeToLogs, type StructuredLogRecord } from "../../src/logger.js";

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

  it("records approval success-path events with correlated actionId/requestId", async () => {
    const app = createTestApp(connMgr, PUB_KEY);
    const { records, unsubscribe } = captureLogs();

    try {
      const createRes = await app.request(`/api/${PUB_KEY}/approval/candidates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: "What matters most?",
          answer: "Trust",
          source: "reading",
        }),
      });
      const created = await createRes.json();

      const approveRes = await app.request(
        `/api/${PUB_KEY}/approval/candidates/${created.data.id}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: "req-success-path", mode: "create_new" }),
        },
      );

      expect(approveRes.status).toBe(200);

      const candidateCreated = findEvents(records, "candidate_created")[0];
      const approvalApplied = findEvents(records, "approval_applied")[0];
      const approvalCommitted = findEvents(records, "approval_committed")[0];
      const formalWrite = findEvents(records, "formal_asset_written")[0];
      const candidateDeleted = findEvents(records, "candidate_deleted")[0];

      expect(candidateCreated).toEqual(
        expect.objectContaining({
          candidateId: created.data.id,
          ownerKey: PUB_KEY,
          source: "reading",
        }),
      );
      expect(approvalApplied).toEqual(
        expect.objectContaining({
          candidateId: created.data.id,
          ownerKey: PUB_KEY,
          requestId: "req-success-path",
        }),
      );
      expect(approvalCommitted).toEqual(
        expect.objectContaining({
          candidateId: created.data.id,
          ownerKey: PUB_KEY,
          requestId: "req-success-path",
        }),
      );
      expect(formalWrite).toEqual(
        expect.objectContaining({
          event: "formal_asset_written",
          actionType: "approval",
          gateway: "controlled_write_service",
          ownerKey: PUB_KEY,
          candidateId: created.data.id,
          requestId: "req-success-path",
        }),
      );
      expect(candidateDeleted).toEqual(
        expect.objectContaining({
          candidateId: created.data.id,
          ownerKey: PUB_KEY,
          requestId: "req-success-path",
        }),
      );
      expect(approvalCommitted?.actionId).toBe(formalWrite?.actionId);
      expect(findEvents(records, "formal_asset_written")).toHaveLength(1);
    } finally {
      unsubscribe();
    }
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

  it("records stale-target and idempotency events for approval retries", async () => {
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    const existing = await service.microEditAsset({
      assetId: null,
      question: "Existing question",
      answer: "Existing answer",
      source: "manual",
      requestId: "seed-observability-existing",
    });
    const candidate = service.createCandidate({
      question: "Updated question",
      answer: "Updated answer",
      source: "reading",
    });
    const app = createTestApp(connMgr, PUB_KEY);
    const { records, unsubscribe } = captureLogs();

    try {
      const staleRes = await app.request(
        `/api/${PUB_KEY}/approval/candidates/${candidate.id}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: "req-stale-log",
            mode: "update_existing",
            targetAssetId: existing.asset.id,
            targetUpdatedAt: existing.asset.updatedAt - 1,
          }),
        },
      );

      expect(staleRes.status).toBe(409);
      expect(findEvents(records, "approval_rejected_stale_target")[0]).toEqual(
        expect.objectContaining({
          candidateId: candidate.id,
          ownerKey: PUB_KEY,
          requestId: "req-stale-log",
        }),
      );

      const successRes = await app.request(
        `/api/${PUB_KEY}/approval/candidates/${candidate.id}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: "req-idempotent", mode: "create_new" }),
        },
      );
      expect(successRes.status).toBe(200);

      const replayRes = await app.request(
        `/api/${PUB_KEY}/approval/candidates/${candidate.id}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: "req-idempotent", mode: "create_new" }),
        },
      );
      expect(replayRes.status).toBe(200);

      expect(findEvents(records, "approval_idempotency_hit")[0]).toEqual(
        expect.objectContaining({
          candidateId: candidate.id,
          ownerKey: PUB_KEY,
          requestId: "req-idempotent",
        }),
      );
    } finally {
      unsubscribe();
    }
  });

  it("POST /api/:pubKey/approval/candidates/:id/approve applies edited text to update_existing", async () => {
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    const existing = await service.microEditAsset({
      assetId: null,
      question: "Existing question",
      answer: "Existing answer",
      source: "manual",
      requestId: "seed-route-existing-asset",
    });
    const candidate = service.createCandidate({
      question: "Original question",
      answer: "Original answer",
      source: "reading",
    });
    const app = createTestApp(connMgr, PUB_KEY);

    const res = await app.request(`/api/${PUB_KEY}/approval/candidates/${candidate.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-route-edited-update",
        mode: "update_existing",
        targetAssetId: existing.asset.id,
        targetUpdatedAt: existing.asset.updatedAt,
        question: "Edited question",
        answer: "Edited answer",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.asset).toEqual(
      expect.objectContaining({
        id: existing.asset.id,
        question: "Edited question",
        answer: "Edited answer",
      }),
    );
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

  it("POST /api/:pubKey/approval/candidates/:id/skip keeps a probe pending without formal write", async () => {
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
    expect(service.listCandidates({ kind: "probe", limit: 10, offset: 0 }).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: candidate.id })]),
    );
  });

  it("records skip events without formal writes", async () => {
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    const candidate = service.createCandidate({
      question: "Ask later",
      answer: null,
      source: "interview",
    });
    const app = createTestApp(connMgr, PUB_KEY);
    const { records, unsubscribe } = captureLogs();

    try {
      const res = await app.request(`/api/${PUB_KEY}/approval/candidates/${candidate.id}/skip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "req-skip-log" }),
      });

      expect(res.status).toBe(200);
      expect(findEvents(records, "candidate_skipped")[0]).toEqual(
        expect.objectContaining({
          candidateId: candidate.id,
          ownerKey: PUB_KEY,
          requestId: "req-skip-log",
        }),
      );
      expect(findEvents(records, "formal_asset_written")).toEqual([]);
    } finally {
      unsubscribe();
    }
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

  it("records undo rollback events and correlates undoneActionId to prior formal writes", async () => {
    const conn = connMgr.getConnection(PUB_KEY);
    const service = createApprovalService({ ownerKey: PUB_KEY, conn, embeddingClient: null });
    const candidate = service.createCandidate({
      question: "Undo approval",
      answer: "Needs rollback",
      source: "manual",
    });
    const approved = await service.approveCandidate({
      candidateId: candidate.id,
      action: "approve",
      mode: "create_new",
      requestId: "req-undo-seed",
    });
    const app = createTestApp(connMgr, PUB_KEY);
    const { records, unsubscribe } = captureLogs();

    try {
      const res = await app.request(`/api/${PUB_KEY}/approval/undo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId: approved.actionId }),
      });

      expect(res.status).toBe(200);

      const undoApplied = findEvents(records, "undo_applied")[0];
      const candidateRestored = findEvents(records, "candidate_restored")[0];
      const rolledBack = findEvents(records, "approval_rolled_back")[0];
      const undoWrite = findEvents(records, "formal_asset_written")[0];

      expect(undoApplied).toEqual(
        expect.objectContaining({
          ownerKey: PUB_KEY,
          undoneActionId: approved.actionId,
          candidateId: candidate.id,
        }),
      );
      expect(candidateRestored).toEqual(
        expect.objectContaining({
          ownerKey: PUB_KEY,
          candidateId: candidate.id,
          actionId: undoApplied?.actionId,
        }),
      );
      expect(rolledBack).toEqual(
        expect.objectContaining({
          ownerKey: PUB_KEY,
          candidateId: candidate.id,
          actionId: undoApplied?.actionId,
        }),
      );
      expect(undoWrite).toEqual(
        expect.objectContaining({
          event: "formal_asset_written",
          actionType: "undo",
          ownerKey: PUB_KEY,
          gateway: "controlled_write_service",
          requestId: null,
          candidateId: candidate.id,
          undoneActionId: approved.actionId,
        }),
      );
    } finally {
      unsubscribe();
    }
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

  it("approval routes no longer serve anchor mutation paths", async () => {
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

    const updateRes = await app.request(`/api/${PUB_KEY}/anchors/${created.asset.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-edit-route", answer: "Edited answer" }),
    });
    const denyRes = await app.request(`/api/${PUB_KEY}/anchors/${created.asset.id}/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-deny-route" }),
    });

    expect(updateRes.status).toBe(404);
    expect(denyRes.status).toBe(404);
  });

  it("builds alert payloads for tx failures and invalid formal writes", () => {
    expect(
      buildApprovalAlert({
        event: "approval_tx_failed",
        ownerKey: PUB_KEY,
        requestId: "req-failed",
        candidateId: "candidate-1",
      }),
    ).toEqual(
      expect.objectContaining({
        alertType: "approval_tx_failed",
        ownerKey: PUB_KEY,
        requestId: "req-failed",
      }),
    );

    expect(
      buildApprovalAlert({
        event: "direct_write_blocked",
        ownerKey: PUB_KEY,
        routeOrModule: "routes/interview",
        attemptedAction: "insert(soulAnchors)",
      }),
    ).toEqual(
      expect.objectContaining({
        alertType: "direct_write_blocked",
        ownerKey: PUB_KEY,
      }),
    );

    expect(
      buildApprovalAlert({
        event: "formal_asset_written",
        ownerKey: PUB_KEY,
        assetId: "asset-1",
        actionId: "action-1",
        candidateId: null,
        requestId: "req-1",
        gateway: "legacy_route",
        actionType: "other",
      }),
    ).toEqual(
      expect.objectContaining({
        alertType: "formal_asset_written_invalid",
        assetId: "asset-1",
        actionType: "other",
        gateway: "legacy_route",
      }),
    );
  });
});
