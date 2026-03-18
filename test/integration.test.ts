import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  getPublicKey,
  sign,
  buildStringToSign,
} from "@remi/crypto";
import { verifyRequest } from "@remi/server/middleware/auth";

describe("end-to-end auth flow", () => {
  it("client signs, server verifies", async () => {
    const privateKey = generateKeyPair();
    const publicKey = getPublicKey(privateKey);
    const method = "POST";
    const path = "/s/somePubKey/ask";
    const timestamp = String(Date.now());
    const body = new TextEncoder().encode('{"question":"你好"}');
    const sts = await buildStringToSign(method, path, timestamp, body);
    const signature = await sign(new TextEncoder().encode(sts), privateKey);

    const result = await verifyRequest({
      method, path, timestamp, body,
      publicKey, signature,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.publicKey).toBe(publicKey);
    }
  });

  it("detects tampered body", async () => {
    const privateKey = generateKeyPair();
    const publicKey = getPublicKey(privateKey);
    const method = "POST";
    const path = "/s/somePubKey/ask";
    const timestamp = String(Date.now());
    const body = new TextEncoder().encode('{"question":"你好"}');
    const sts = await buildStringToSign(method, path, timestamp, body);
    const signature = await sign(new TextEncoder().encode(sts), privateKey);

    const tampered = new TextEncoder().encode('{"question":"篡改"}');
    const result = await verifyRequest({
      method, path, timestamp,
      body: tampered,
      publicKey, signature,
    });
    expect(result.ok).toBe(false);
  });
});
