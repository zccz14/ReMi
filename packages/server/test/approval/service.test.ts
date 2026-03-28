import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getSoulAssetKind,
  normalizeAnswer,
  normalizeQuestion,
} from "../../src/approval/normalize.js";
import { ConnectionManager } from "../../src/db/connection.js";
import { createApprovalService } from "../../src/approval/service.js";
import type { EmbeddingClient } from "../../src/embedding/client.js";

describe("approval normalization", () => {
  it("trims a question before persistence", () => {
    expect(normalizeQuestion("  What matters?  ")).toBe("What matters?");
  });

  it("rejects a blank question", () => {
    expect(() => normalizeQuestion("   ")).toThrow(/question/i);
  });

  it("collapses a blank answer to null", () => {
    expect(normalizeAnswer("   ")).toBeNull();
  });

  it("classifies null answers as probes", () => {
    expect(getSoulAssetKind({ answer: null })).toBe("probe");
  });

  it("classifies populated answers as anchors", () => {
    expect(getSoulAssetKind({ answer: "Answer" })).toBe("anchor");
  });
});

describe("approval service candidate ingestion", () => {
  function createService() {
    const tmpDir = path.join(os.tmpdir(), `remi-approval-service-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const connMgr = new ConnectionManager(tmpDir, { maxSize: 2, embeddingDimensions: 4 });
    const ownerKey = "owner-pub-key";
    const conn = connMgr.getConnection(ownerKey, { create: true });
    const embedMock = vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]));
    const embeddingClient: EmbeddingClient = {
      embed: embedMock,
    };
    const service = createApprovalService({ ownerKey, conn, embeddingClient });

    return {
      service,
      conn,
      embedMock,
      cleanup() {
        connMgr.closeAll();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      },
    };
  }

  it("creates candidates through a shared ingestion API", async () => {
    const { service, cleanup } = createService();

    try {
      const created = service.createCandidate({
        question: "  What matters most?  ",
        answer: "  Trust  ",
        source: "manual",
      });

      expect(created).toEqual(
        expect.objectContaining({
          question: "What matters most?",
          answer: "Trust",
          source: "manual",
          kind: "anchor",
        }),
      );
    } finally {
      cleanup();
    }
  });

  it("stores display-ready source context for interview and reading candidates", async () => {
    const { service, cleanup } = createService();

    try {
      const interviewCandidate = service.createCandidate({
        question: "What value keeps coming up?",
        answer: "Trust",
        source: "interview",
        sourceRef: "session-1:turn-2",
        sourceSnapshot: { excerpt: "Trust matters most.", turn: 2 },
      });

      const readingCandidate = service.createCandidate({
        question: "How do I handle conflict?",
        answer: "I set clear boundaries.",
        source: "reading",
        sourceRef: "reading-round-1",
        sourceSnapshot: { snippet: "I set clear boundaries.", locale: "en" },
      });

      expect(interviewCandidate.sourceRef).toBe("session-1:turn-2");
      expect(interviewCandidate.sourceSnapshot).toContain("Trust matters most.");
      expect(readingCandidate.sourceRef).toBe("reading-round-1");
      expect(readingCandidate.sourceSnapshot).toContain("clear boundaries");
    } finally {
      cleanup();
    }
  });

  it("lists anchor and probe candidates by normalized answer kind", async () => {
    const { service, cleanup } = createService();

    try {
      service.createCandidate({
        question: "What matters most?",
        answer: "Trust",
        source: "manual",
      });
      service.createCandidate({
        question: "What should I ask next?",
        answer: "   ",
        source: "reading",
      });

      const anchorCandidates = service.listCandidates({ kind: "anchor", limit: 10, offset: 0 });
      const probeCandidates = service.listCandidates({ kind: "probe", limit: 10, offset: 0 });

      expect(anchorCandidates.items).toHaveLength(1);
      expect(anchorCandidates.items[0]?.kind).toBe("anchor");
      expect(probeCandidates.items).toHaveLength(1);
      expect(probeCandidates.items[0]).toEqual(
        expect.objectContaining({ answer: null, kind: "probe", source: "reading" }),
      );
    } finally {
      cleanup();
    }
  });

  it("approves candidate into formal asset and deletes candidate atomically", async () => {
    const { service, conn, cleanup } = createService();

    try {
      const candidate = service.createCandidate({
        question: "  What matters most?  ",
        answer: "  Trust  ",
        source: "reading",
      });

      const approved = await service.approveCandidate({
        candidateId: candidate.id,
        action: "approve",
        mode: "create_new",
        requestId: "req-approve-1",
      });

      expect(approved.asset).toEqual(
        expect.objectContaining({
          question: "What matters most?",
          answer: "Trust",
          source: "reading",
        }),
      );
      expect(service.listCandidates({ kind: "anchor", limit: 10, offset: 0 }).items).toHaveLength(
        0,
      );

      const lastAction = conn.raw
        .prepare("SELECT action_id FROM approval_last_actions WHERE owner_key = ?")
        .get("owner-pub-key") as { action_id: string } | undefined;
      expect(lastAction?.action_id).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it("rejects stale update_existing requests and keeps candidate pending", async () => {
    const { service, cleanup } = createService();

    try {
      const existing = await service.microEditAsset({
        assetId: null,
        question: "Existing question",
        answer: "Existing answer",
        source: "manual",
        requestId: "seed-existing-asset",
      });
      const candidate = service.createCandidate({
        question: "Existing question",
        answer: "Updated answer",
        source: "reading",
      });

      await expect(
        service.approveCandidate({
          candidateId: candidate.id,
          action: "approve",
          mode: "update_existing",
          targetAssetId: existing.asset.id,
          targetUpdatedAt: existing.asset.updatedAt - 1,
          requestId: "req-stale-1",
        }),
      ).rejects.toThrow(/stale|updated/i);

      expect(service.listCandidates({ kind: "anchor", limit: 10, offset: 0 }).items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: candidate.id })]),
      );
    } finally {
      cleanup();
    }
  });

  it("routes deny to answer=null and recalculates kind as probe", async () => {
    const { service, cleanup } = createService();

    try {
      const created = await service.microEditAsset({
        assetId: null,
        question: "What matters most?",
        answer: "Trust",
        source: "reading",
        requestId: "seed-deny-asset",
      });

      const denied = await service.denyAsset({
        assetId: created.asset.id,
        requestId: "deny-1",
      });

      expect(denied.asset.answer).toBeNull();
      expect(denied.asset.source).toBe("reading");
      expect(getSoulAssetKind({ answer: denied.asset.answer })).toBe("probe");
    } finally {
      cleanup();
    }
  });

  it("keeps soul_anchors_vec in sync for create, update, and deny", async () => {
    const { service, conn, cleanup } = createService();

    try {
      const candidate = service.createCandidate({
        question: "What matters most?",
        answer: "Trust",
        source: "manual",
      });

      const approved = await service.approveCandidate({
        candidateId: candidate.id,
        action: "approve",
        mode: "create_new",
        requestId: "req-vector-create",
      });

      const afterCreate = conn.raw
        .prepare("SELECT COUNT(*) as count FROM soul_anchors_vec WHERE id = ?")
        .get(approved.asset.id) as { count: number };
      expect(afterCreate.count).toBe(1);

      const edited = await service.microEditAsset({
        assetId: approved.asset.id,
        question: "What matters most now?",
        answer: "Trust and steadiness",
        source: approved.asset.source,
        requestId: "req-vector-update",
      });

      const afterUpdate = conn.raw
        .prepare("SELECT COUNT(*) as count FROM soul_anchors_vec WHERE id = ?")
        .get(edited.asset.id) as { count: number };
      expect(afterUpdate.count).toBe(1);

      const denied = await service.denyAsset({
        assetId: edited.asset.id,
        requestId: "req-vector-deny",
      });
      const afterDeny = conn.raw
        .prepare("SELECT COUNT(*) as count FROM soul_anchors_vec WHERE id = ?")
        .get(denied.asset.id) as { count: number };
      expect(afterDeny.count).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("dedupes candidateId and requestId via approval_requests", async () => {
    const { service, cleanup } = createService();

    try {
      const candidate = service.createCandidate({
        question: "What matters most?",
        answer: "Trust",
        source: "manual",
      });

      const first = await service.approveCandidate({
        candidateId: candidate.id,
        action: "approve",
        mode: "create_new",
        requestId: "req-dedupe-1",
      });
      const second = await service.approveCandidate({
        candidateId: candidate.id,
        action: "approve",
        mode: "create_new",
        requestId: "req-dedupe-1",
      });

      expect(second).toEqual(first);
    } finally {
      cleanup();
    }
  });

  it("stores one last_action per owner and restores candidate on undo", async () => {
    const { service, cleanup } = createService();

    try {
      const candidate = service.createCandidate({
        question: "What matters most?",
        answer: "Trust",
        source: "reading",
      });

      const approved = await service.approveCandidate({
        candidateId: candidate.id,
        action: "approve",
        mode: "create_new",
        requestId: "req-undo-1",
      });

      const undone = await service.undoLastAction({ actionId: approved.actionId });

      expect(undone.restoredCandidate).toEqual(
        expect.objectContaining({ id: candidate.id, question: "What matters most?" }),
      );
      expect(service.listCandidates({ kind: "anchor", limit: 10, offset: 0 }).items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: candidate.id })]),
      );
    } finally {
      cleanup();
    }
  });

  it("resyncs vectors on undo rollback", async () => {
    const { service, conn, embedMock, cleanup } = createService();

    try {
      const created = await service.microEditAsset({
        assetId: null,
        question: "What matters most?",
        answer: "Trust",
        source: "manual",
        requestId: "req-undo-vector-seed",
      });

      const denied = await service.denyAsset({
        assetId: created.asset.id,
        requestId: "req-undo-vector-deny",
      });

      await service.undoLastAction({ actionId: denied.actionId });

      const embeddingRow = conn.raw
        .prepare("SELECT COUNT(*) as count FROM soul_anchors_vec WHERE id = ?")
        .get(created.asset.id) as { count: number };

      expect(embeddingRow.count).toBe(1);
      expect(embedMock).toHaveBeenCalledTimes(3);
    } finally {
      cleanup();
    }
  });
});
