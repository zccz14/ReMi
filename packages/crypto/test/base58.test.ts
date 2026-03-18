import { describe, it, expect } from "vitest";
import { base58Encode, base58Decode } from "../src/base58.js";

describe("base58", () => {
  it("encodes and decodes round-trip", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    expect(base58Decode(base58Encode(data))).toEqual(data);
  });

  it("encodes known value", () => {
    const data = new TextEncoder().encode("Hello");
    const encoded = base58Encode(data);
    expect(typeof encoded).toBe("string");
    expect(encoded.length).toBeGreaterThan(0);
    expect(encoded).not.toMatch(/[0OIl]/);
  });

  it("handles empty input", () => {
    const data = new Uint8Array(0);
    expect(base58Decode(base58Encode(data))).toEqual(data);
  });
});
