// @vitest-environment node
import { describe, expect, it } from "vitest";
import { pwaOptions } from "../vite.config";

describe("vite PWA config", () => {
  it('uses registerType: "prompt" for explicit updates', () => {
    expect(pwaOptions.registerType).toBe("prompt");
  });
});
