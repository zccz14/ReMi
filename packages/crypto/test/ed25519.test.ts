import { describe, it, expect } from "vitest";
import { generateKeyPair, getPublicKey, sign, verify } from "../src/ed25519.js";

describe("ed25519", () => {
  it("generates a private key as base58 string", () => {
    const privateKey = generateKeyPair();
    expect(typeof privateKey).toBe("string");
    expect(privateKey.length).toBeGreaterThan(0);
  });

  it("derives public key from private key", () => {
    const privateKey = generateKeyPair();
    const publicKey = getPublicKey(privateKey);
    expect(typeof publicKey).toBe("string");
    expect(publicKey).not.toBe(privateKey);
  });

  it("signs and verifies", async () => {
    const privateKey = generateKeyPair();
    const publicKey = getPublicKey(privateKey);
    const message = new TextEncoder().encode("hello");
    const signature = await sign(message, privateKey);
    expect(await verify(message, signature, publicKey)).toBe(true);
  });

  it("rejects tampered message", async () => {
    const privateKey = generateKeyPair();
    const publicKey = getPublicKey(privateKey);
    const message = new TextEncoder().encode("hello");
    const signature = await sign(message, privateKey);
    const tampered = new TextEncoder().encode("world");
    expect(await verify(tampered, signature, publicKey)).toBe(false);
  });

  it("rejects wrong public key", async () => {
    const priv1 = generateKeyPair();
    const priv2 = generateKeyPair();
    const pub2 = getPublicKey(priv2);
    const message = new TextEncoder().encode("hello");
    const signature = await sign(message, priv1);
    expect(await verify(message, signature, pub2)).toBe(false);
  });
});
