import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decodeCiphertextEnvelope,
  decryptBodyEnvelope,
  encodeCiphertextEnvelope,
  encryptBodyForRecipient,
  unwrapEnvelopeKeyForRecipient,
} from "../../src/messaging/crypto.js";

describe("encodeCiphertextEnvelope", () => {
  it("encodes and decodes the fixed envelope wire order as base64", () => {
    const wrappedKey = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
    const iv = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const ciphertextBody = Buffer.from([0x10, 0x20, 0x30]);
    const tag = Buffer.from(Array.from({ length: 16 }, (_, index) => index + 1));

    const envelope = encodeCiphertextEnvelope({
      wrappedKey,
      iv,
      ciphertextBody,
      tag,
    });

    expect(envelope).toMatch(/^[A-Za-z0-9+/]+=*$/);

    const raw = Buffer.from(envelope, "base64");
    expect(raw).toEqual(
      Buffer.concat([
        Buffer.from([0x01]),
        Buffer.from([0x00, 0x04]),
        wrappedKey,
        iv,
        ciphertextBody,
        tag,
      ]),
    );

    expect(decodeCiphertextEnvelope(envelope)).toEqual({
      version: 0x01,
      wrappedKey,
      iv,
      ciphertextBody,
      tag,
    });
  });
});

describe("decryptBodyEnvelope", () => {
  it("normalizes malformed wrapped_key payload failures", () => {
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    const envelope = encryptBodyForRecipient(
      '{"type":"text","version":1,"text":"hello"}',
      publicKey,
    );
    const decoded = decodeCiphertextEnvelope(envelope);
    const malformedEnvelope = encodeCiphertextEnvelope({
      version: decoded.version,
      wrappedKey: decoded.wrappedKey.subarray(0, decoded.wrappedKey.length - 5),
      iv: decoded.iv,
      ciphertextBody: decoded.ciphertextBody,
      tag: decoded.tag,
    });

    expect(() => decryptBodyEnvelope(malformedEnvelope, privateKey)).toThrow(
      "Failed to decrypt body envelope",
    );
  });

  it("normalizes malformed ephemeral public key failures", () => {
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    const envelope = encryptBodyForRecipient(
      '{"type":"text","version":1,"text":"hello"}',
      publicKey,
    );
    const decoded = decodeCiphertextEnvelope(envelope);
    const malformedWrappedKey = Buffer.from(decoded.wrappedKey);
    malformedWrappedKey.writeUInt16BE(32, 0);
    malformedWrappedKey.fill(0xff, 2, 34);

    const malformedEnvelope = encodeCiphertextEnvelope({
      version: decoded.version,
      wrappedKey: malformedWrappedKey,
      iv: decoded.iv,
      ciphertextBody: decoded.ciphertextBody,
      tag: decoded.tag,
    });

    expect(() => decryptBodyEnvelope(malformedEnvelope, privateKey)).toThrow(
      "Failed to decrypt body envelope",
    );
  });

  it("normalizes invalid wrapped_key_length envelope failures", () => {
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    const envelope = encryptBodyForRecipient(
      '{"type":"text","version":1,"text":"hello"}',
      publicKey,
    );
    const raw = Buffer.from(envelope, "base64");
    raw.writeUInt16BE(0xffff, 1);

    expect(() => decryptBodyEnvelope(raw.toString("base64"), privateKey)).toThrow(
      "Failed to decrypt body envelope",
    );
  });

  it("fails authentication when the ciphertext body is tampered", () => {
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    const envelope = encryptBodyForRecipient(
      '{"type":"text","version":1,"text":"hello"}',
      publicKey,
    );
    const decoded = decodeCiphertextEnvelope(envelope);
    const tamperedBody = Buffer.from(decoded.ciphertextBody);
    tamperedBody[0] ^= 0xff;

    const tamperedEnvelope = encodeCiphertextEnvelope({
      version: decoded.version,
      wrappedKey: decoded.wrappedKey,
      iv: decoded.iv,
      ciphertextBody: tamperedBody,
      tag: decoded.tag,
    });

    expect(() => decryptBodyEnvelope(tamperedEnvelope, privateKey)).toThrow(/auth|decrypt/i);
  });

  it("fails authentication when the tag is tampered", () => {
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    const envelope = encryptBodyForRecipient(
      '{"type":"text","version":1,"text":"hello"}',
      publicKey,
    );
    const decoded = decodeCiphertextEnvelope(envelope);
    const tamperedTag = Buffer.from(decoded.tag);
    tamperedTag[tamperedTag.length - 1] ^= 0xff;

    const tamperedEnvelope = encodeCiphertextEnvelope({
      version: decoded.version,
      wrappedKey: decoded.wrappedKey,
      iv: decoded.iv,
      ciphertextBody: decoded.ciphertextBody,
      tag: tamperedTag,
    });

    expect(() => decryptBodyEnvelope(tamperedEnvelope, privateKey)).toThrow(/auth|decrypt/i);
  });

  it("uses a fresh AES key and IV for every encryption of the same plaintext", () => {
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    const plaintext = '{"type":"text","version":1,"text":"hello"}';

    const first = encryptBodyForRecipient(plaintext, publicKey);
    const second = encryptBodyForRecipient(plaintext, publicKey);

    expect(first).not.toBe(second);
    expect(decryptBodyEnvelope(first, privateKey)).toBe(plaintext);
    expect(decryptBodyEnvelope(second, privateKey)).toBe(plaintext);

    const firstEnvelope = decodeCiphertextEnvelope(first);
    const secondEnvelope = decodeCiphertextEnvelope(second);
    const firstAesKey = unwrapEnvelopeKeyForRecipient(first, privateKey);
    const secondAesKey = unwrapEnvelopeKeyForRecipient(second, privateKey);

    expect(firstEnvelope.iv.equals(secondEnvelope.iv)).toBe(false);
    expect(firstEnvelope.wrappedKey.equals(secondEnvelope.wrappedKey)).toBe(false);
    expect(firstAesKey.equals(secondAesKey)).toBe(false);
  });
});
