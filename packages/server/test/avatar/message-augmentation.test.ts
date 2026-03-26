import { describe, expect, it } from "vitest";
import { buildPlatformSegment } from "../../src/avatar/message-augmentation.js";

describe("buildPlatformSegment", () => {
  it("requires investigation before environment-dependent reasoning", () => {
    const prompt = buildPlatformSegment();

    expect(prompt).toContain(
      "Do not jump into reasoning before understanding the caller's environment",
    );
    expect(prompt).toContain("current task");
    expect(prompt).toContain("constraints");
    expect(prompt).toContain("relationship");
  });

  it("requires minimum necessary questions when key context is missing", () => {
    const prompt = buildPlatformSegment();

    expect(prompt).toContain("minimum necessary questions");
  });

  it("allows direct answers for low-risk or environment-independent requests", () => {
    const prompt = buildPlatformSegment();

    expect(prompt).toContain("low-risk");
    expect(prompt).toContain("answered directly");
  });

  it("uses existing context and requires explicit assumptions when needed", () => {
    const prompt = buildPlatformSegment();

    expect(prompt).toContain("existing context");
    expect(prompt).toContain("avoid repeated questioning");
    expect(prompt).toContain("state assumptions explicitly");
  });

  it("keeps temporary judgment conditional when context is incomplete", () => {
    const prompt = buildPlatformSegment();

    expect(prompt).toContain("incomplete context");
    expect(prompt).toContain("keep it conditional");
    expect(prompt).toContain("state assumptions explicitly");
  });

  it("investigates missing goals, constraints, permissions, time, or relationship boundaries only when material", () => {
    const prompt = buildPlatformSegment();

    expect(prompt).toContain("goals");
    expect(prompt).toContain("constraints");
    expect(prompt).toContain("permissions");
    expect(prompt).toContain("time");
    expect(prompt).toContain("relationship boundaries");
    expect(prompt).toContain("materially affect the answer");
  });
});
