import { describe, expect, it } from "vitest";
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
    const service = createApprovalService({ ownerKey, conn });

    return {
      service,
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
});
