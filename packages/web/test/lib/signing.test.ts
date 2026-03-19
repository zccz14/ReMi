import { describe, it, expect } from "vitest";
import { base58Encode, base58Decode } from "../../src/lib/base58";
import { hashBody, buildStringToSign } from "../../src/lib/signing";

describe("base58", () => {
  it("should roundtrip encode/decode", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = base58Encode(data);
    expect(typeof encoded).toBe("string");
    expect(base58Decode(encoded)).toEqual(data);
  });
});

describe("hashBody", () => {
  it("should hash empty body", async () => {
    const hash = await hashBody(undefined);
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  it("should produce consistent hashes", async () => {
    const body = new TextEncoder().encode('{"content":"hello"}');
    const h1 = await hashBody(body);
    const h2 = await hashBody(body);
    expect(h1).toBe(h2);
  });

  it("should differ for different bodies", async () => {
    const b1 = new TextEncoder().encode("a");
    const b2 = new TextEncoder().encode("b");
    expect(await hashBody(b1)).not.toBe(await hashBody(b2));
  });
});

describe("buildStringToSign", () => {
  it("should construct METHOD\\nPATH\\nTIMESTAMP\\nBODYHASH", async () => {
    const result = await buildStringToSign("GET", "/api/abc/anchors", "1700000000000");
    const parts = result.split("\n");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("GET");
    expect(parts[1]).toBe("/api/abc/anchors");
    expect(parts[2]).toBe("1700000000000");
    expect(parts[3].length).toBeGreaterThan(0);
  });

  it("should include body hash when body provided", async () => {
    const body = new TextEncoder().encode('{"content":"hi"}');
    const withBody = await buildStringToSign("POST", "/api/abc/message", "123", body);
    const withoutBody = await buildStringToSign("POST", "/api/abc/message", "123");
    expect(withBody.split("\n")[3]).not.toBe(withoutBody.split("\n")[3]);
  });
});
