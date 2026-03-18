import { describe, it, expect } from "vitest";
import { determineRole } from "../../src/middleware/role.js";

describe("determineRole", () => {
  it("returns 'owner' when signer matches target", () => {
    const key = "abc123base58key";
    expect(determineRole(key, key)).toBe("owner");
  });

  it("returns 'visitor' when signer differs from target", () => {
    expect(determineRole("signerKey", "ownerKey")).toBe("visitor");
  });
});
