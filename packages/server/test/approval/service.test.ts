import { describe, expect, it } from "vitest";
import {
  getSoulAssetKind,
  normalizeAnswer,
  normalizeQuestion,
} from "../../src/approval/normalize.js";

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
