import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  getPublicKey,
  sign,
  buildStringToSign,
} from "@remi/crypto";
import { verifyRequest } from "../../src/middleware/auth.js";

describe("verifyRequest", () => {
  async function makeSignedRequest(opts: {
    timestampOverride?: string;
  } = {}) {
    const privateKey = generateKeyPair();
    const publicKey = getPublicKey(privateKey);
    const method = "POST";
    const path = "/test";
    const timestamp = opts.timestampOverride ?? String(Date.now());
    const body = new TextEncoder().encode('{"q":"hi"}');
    const sts = await buildStringToSign(method, path, timestamp, body);
    const signature = await sign(new TextEncoder().encode(sts), privateKey);
    return { method, path, timestamp, body, publicKey, signature };
  }

  it("accepts valid signature", async () => {
    const req = await makeSignedRequest();
    const result = await verifyRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.publicKey).toBe(req.publicKey);
  });

  it("rejects missing public key", async () => {
    const req = await makeSignedRequest();
    const result = await verifyRequest({ ...req, publicKey: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("MISSING_AUTH_HEADER");
  });

  it("rejects expired timestamp", async () => {
    const old = String(Date.now() - 60_000);
    const req = await makeSignedRequest({ timestampOverride: old });
    const result = await verifyRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("TIMESTAMP_EXPIRED");
  });

  it("rejects invalid signature", async () => {
    const req = await makeSignedRequest();
    const result = await verifyRequest({ ...req, signature: "badSig123" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("INVALID_SIGNATURE");
  });
});
