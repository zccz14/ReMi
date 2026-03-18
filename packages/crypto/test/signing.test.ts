import { describe, it, expect } from "vitest";
import { buildStringToSign, hashBody } from "../src/signing.js";

describe("hashBody", () => {
  it("hashes non-empty body", async () => {
    const body = new TextEncoder().encode('{"key":"value"}');
    const hash = await hashBody(body);
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  it("hashes empty body deterministically", async () => {
    const hash1 = await hashBody(undefined);
    const hash2 = await hashBody(null);
    const hash3 = await hashBody(new Uint8Array(0));
    expect(hash1).toBe(hash2);
    expect(hash2).toBe(hash3);
  });
});

describe("buildStringToSign", () => {
  it("constructs correct format", async () => {
    const result = await buildStringToSign(
      "POST",
      "/souls/abc/anchors?page=1",
      "1710000000000",
      new TextEncoder().encode('{"q":"hello"}')
    );
    const lines = result.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("POST");
    expect(lines[1]).toBe("/souls/abc/anchors?page=1");
    expect(lines[2]).toBe("1710000000000");
    expect(lines[3].length).toBeGreaterThan(0);
  });

  it("handles GET with no body", async () => {
    const result = await buildStringToSign(
      "GET",
      "/health",
      "1710000000000",
      undefined
    );
    const lines = result.split("\n");
    expect(lines[0]).toBe("GET");
    expect(lines[3]).toBe(
      await (async () => {
        const { hashBody } = await import("../src/signing.js");
        return hashBody(undefined);
      })()
    );
  });
});
