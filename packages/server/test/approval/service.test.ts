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
  function createService(options?: { embedImpl?: (texts: string[]) => Promise<number[][]> }) {
    const tmpDir = path.join(os.tmpdir(), `remi-approval-service-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const connMgr = new ConnectionManager(tmpDir, { maxSize: 2, embeddingDimensions: 4 });
    const ownerKey = "owner-pub-key";
    const conn = connMgr.getConnection(ownerKey, { create: true });
    const embedMock = vi.fn(
      options?.embedImpl ?? (async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4])),
    );
    const embeddingClient: EmbeddingClient = {
      embed: embedMock,
    };
    const service = createApprovalService({ ownerKey, conn, embeddingClient });

    return {
      service,
      conn,
      ownerKey,
      tmpDir,
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

  it("rejects a candidate without formal write and restores it on undo", async () => {
    const { service, conn, cleanup } = createService();

    try {
      const candidate = service.createCandidate({
        question: "What matters most?",
        answer: "Trust",
        source: "reading",
      });

      const rejected = await service.approveCandidate({
        candidateId: candidate.id,
        action: "reject",
        mode: "create_new",
        requestId: "req-reject-1",
      });

      expect(rejected.asset).toBeNull();
      expect(service.listCandidates({ kind: "anchor", limit: 10, offset: 0 }).items).toHaveLength(
        0,
      );

      const anchorCount = conn.raw.prepare("SELECT COUNT(*) as count FROM soul_anchors").get() as {
        count: number;
      };
      expect(anchorCount.count).toBe(0);

      const undone = await service.undoLastAction({ actionId: rejected.actionId });
      expect(undone.restoredCandidate).toEqual(expect.objectContaining({ id: candidate.id }));
    } finally {
      cleanup();
    }
  });

  it("skips a probe without deleting it from the queue", async () => {
    const { service, conn, cleanup } = createService();

    try {
      const candidate = service.createCandidate({
        question: "Ask later?",
        answer: null,
        source: "interview",
      });

      const skipped = await service.skipCandidate({
        candidateId: candidate.id,
        requestId: "req-skip-1",
      });

      expect(skipped.asset).toBeNull();
      expect(service.listCandidates({ kind: "probe", limit: 10, offset: 0 }).items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: candidate.id })]),
      );
      const requestCount = conn.raw
        .prepare("SELECT COUNT(*) as count FROM approval_requests WHERE candidate_id = ?")
        .get(candidate.id) as { count: number };
      expect(requestCount.count).toBe(1);
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

  it("uses edited question and answer when approving update_existing", async () => {
    const { service, cleanup } = createService();

    try {
      const existing = await service.microEditAsset({
        assetId: null,
        question: "Existing question",
        answer: "Existing answer",
        source: "manual",
        requestId: "seed-edited-asset",
      });
      const candidate = service.createCandidate({
        question: "Original question",
        answer: "Original answer",
        source: "reading",
      });

      const approved = await service.approveCandidate({
        candidateId: candidate.id,
        action: "approve",
        mode: "update_existing",
        targetAssetId: existing.asset.id,
        targetUpdatedAt: existing.asset.updatedAt,
        question: "Edited question",
        answer: "Edited answer",
        requestId: "req-edited-update-1",
      });

      expect(approved.asset).toEqual(
        expect.objectContaining({
          id: existing.asset.id,
          question: "Edited question",
          answer: "Edited answer",
          source: "reading",
        }),
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

  it("serializes deny so concurrent edits cannot clobber question and source", async () => {
    let resolveDenyEmbedding: ((value: number[][]) => void) | null = null;
    let embedCallCount = 0;
    const { service, tmpDir, ownerKey, cleanup } = createService({
      embedImpl: async (texts: string[]) => {
        embedCallCount += 1;

        if (embedCallCount !== 2) {
          return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
        }

        return await new Promise<number[][]>((resolve) => {
          resolveDenyEmbedding = resolve;
        });
      },
    });
    const concurrentMgr = new ConnectionManager(tmpDir, { maxSize: 1, embeddingDimensions: 4 });
    const concurrentConn = concurrentMgr.getConnection(ownerKey);
    concurrentConn.raw.pragma("busy_timeout = 1");
    const concurrentService = createApprovalService({
      ownerKey,
      conn: concurrentConn,
      embeddingClient: null,
    });

    try {
      const created = await service.microEditAsset({
        assetId: null,
        question: "Original question",
        answer: "Original answer",
        source: "reading",
        requestId: "seed-deny-race-asset",
      });

      const denyPromise = service.denyAsset({
        assetId: created.asset.id,
        requestId: "deny-race-1",
      });

      await Promise.resolve();

      await expect(
        concurrentService.microEditAsset({
          assetId: created.asset.id,
          question: "Concurrent question",
          answer: "Concurrent answer",
          source: "interview",
          requestId: "deny-race-concurrent-edit",
        }),
      ).rejects.toThrow(/locked|busy/i);

      const releaseDenyEmbedding = resolveDenyEmbedding as ((value: number[][]) => void) | null;
      if (!releaseDenyEmbedding) {
        throw new Error("Expected deny embedding to be pending");
      }
      releaseDenyEmbedding([[0.1, 0.2, 0.3, 0.4]]);
      const denied = await denyPromise;

      expect(denied.asset).toEqual(
        expect.objectContaining({
          question: "Original question",
          answer: null,
          source: "reading",
        }),
      );
    } finally {
      concurrentMgr.closeAll();
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
      expect(approved.asset).not.toBeNull();
      const approvedAsset = approved.asset!;

      const afterCreate = conn.raw
        .prepare("SELECT COUNT(*) as count FROM soul_anchors_vec WHERE id = ?")
        .get(approvedAsset.id) as { count: number };
      expect(afterCreate.count).toBe(1);

      const edited = await service.microEditAsset({
        assetId: approvedAsset.id,
        question: "What matters most now?",
        answer: "Trust and steadiness",
        source: approvedAsset.source,
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

  it("dedupes micro edits and deny requests via approval_requests", async () => {
    const { service, cleanup } = createService();

    try {
      const created = await service.microEditAsset({
        assetId: null,
        question: "What matters most?",
        answer: "Trust",
        source: "manual",
        requestId: "req-micro-create-1",
      });

      const firstEdit = await service.microEditAsset({
        assetId: created.asset.id,
        question: "What matters most now?",
        answer: "Trust and steadiness",
        source: "manual",
        requestId: "req-micro-edit-1",
      });
      const secondEdit = await service.microEditAsset({
        assetId: created.asset.id,
        question: "ignored duplicate payload",
        answer: "ignored duplicate payload",
        source: "reading",
        requestId: "req-micro-edit-1",
      });

      expect(secondEdit).toEqual(firstEdit);

      const firstDeny = await service.denyAsset({
        assetId: created.asset.id,
        requestId: "req-deny-idempotent-1",
      });
      const secondDeny = await service.denyAsset({
        assetId: created.asset.id,
        requestId: "req-deny-idempotent-1",
      });

      expect(secondDeny).toEqual(firstDeny);
    } finally {
      cleanup();
    }
  });

  it("keeps candidate pending when embedding sync fails before approval commit", async () => {
    const { service, conn, cleanup } = createService({
      embedImpl: async () => {
        throw new Error("embedding failed");
      },
    });

    try {
      const candidate = service.createCandidate({
        question: "What matters most?",
        answer: "Trust",
        source: "manual",
      });

      await expect(
        service.approveCandidate({
          candidateId: candidate.id,
          action: "approve",
          mode: "create_new",
          requestId: "req-embed-fail-1",
        }),
      ).rejects.toThrow(/embedding failed/i);

      expect(service.listCandidates({ kind: "anchor", limit: 10, offset: 0 }).items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: candidate.id })]),
      );

      const anchorCount = conn.raw.prepare("SELECT COUNT(*) as count FROM soul_anchors").get() as {
        count: number;
      };
      expect(anchorCount.count).toBe(0);
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
