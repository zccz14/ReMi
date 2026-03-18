import { describe, it, expect, beforeEach } from "vitest";
import { KeyStore } from "../src/keystore.js";
import { verify, buildStringToSign } from "@remi/crypto";

describe("KeyStore", () => {
  let ks: KeyStore;

  beforeEach(async () => {
    ks = new KeyStore();
    await ks.init();
  });

  it("initializes and generates key", () => {
    const pub = ks.getPublicKey();
    expect(typeof pub).toBe("string");
    expect(pub.length).toBeGreaterThan(0);
  });

  it("is ephemeral in test environment (no IndexedDB)", () => {
    expect(ks.isEphemeral()).toBe(true);
  });

  it("signs data that can be verified", async () => {
    const message = new TextEncoder().encode("test message");
    const sig = await ks.sign(message);
    const pub = ks.getPublicKey();
    expect(await verify(message, sig, pub)).toBe(true);
  });

  it("exports and imports private key", async () => {
    const original = ks.getPublicKey();
    const exported = ks.exportPrivateKey();

    const ks2 = new KeyStore();
    await ks2.init();
    await ks2.importPrivateKey(exported);
    expect(ks2.getPublicKey()).toBe(original);
  });

  it("rejects invalid private key on import", async () => {
    await expect(ks.importPrivateKey("not-a-valid-key!!!"))
      .rejects.toThrow();
  });

  it("produces valid signature for auth protocol", async () => {
    const method = "GET";
    const path = "/test";
    const timestamp = String(Date.now());
    const sts = await buildStringToSign(method, path, timestamp, undefined);
    const sig = await ks.sign(new TextEncoder().encode(sts));
    const pub = ks.getPublicKey();
    expect(await verify(new TextEncoder().encode(sts), sig, pub)).toBe(true);
  });
});
