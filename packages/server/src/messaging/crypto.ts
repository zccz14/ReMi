import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type BinaryLike,
  type KeyObject,
} from "node:crypto";
import { x25519 } from "@noble/curves/ed25519";

const ENVELOPE_VERSION = 0x01;
const AES_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_KEY_EPHEMERAL_LENGTH_BYTES = 2;
const EMPTY_SALT = Buffer.alloc(0);
const WRAP_INFO = Buffer.from("remi.messaging.crypto.wrap.v1", "utf8");
const DECRYPT_BODY_ENVELOPE_ERROR = "Failed to decrypt body envelope";

type PublicKeyInput = KeyObject | string | Buffer | Uint8Array;
type PrivateKeyInput = KeyObject | string | Buffer | Uint8Array;

export interface CiphertextEnvelopeParts {
  version?: number;
  wrappedKey: Uint8Array;
  iv: Uint8Array;
  ciphertextBody: Uint8Array;
  tag: Uint8Array;
}

export interface DecodedCiphertextEnvelope {
  version: number;
  wrappedKey: Buffer;
  iv: Buffer;
  ciphertextBody: Buffer;
  tag: Buffer;
}

export function encryptBodyForRecipient(
  plaintext: string | Uint8Array,
  recipientPublicKey: PublicKeyInput,
): string {
  const aesKey = randomBytes(AES_KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  const ciphertextBody = Buffer.concat([cipher.update(asBinary(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();

  return encodeCiphertextEnvelope({
    wrappedKey: wrapAesKeyForRecipient(aesKey, recipientPublicKey),
    iv,
    ciphertextBody,
    tag,
  });
}

export function decryptBodyEnvelope(
  envelopeBase64: string,
  recipientPrivateKey: PrivateKeyInput,
): string {
  try {
    const envelope = decodeCiphertextEnvelope(envelopeBase64);
    const aesKey = unwrapEnvelopeKeyForRecipient(envelopeBase64, recipientPrivateKey);
    const decipher = createDecipheriv("aes-256-gcm", aesKey, envelope.iv);
    decipher.setAuthTag(envelope.tag);

    return Buffer.concat([decipher.update(envelope.ciphertextBody), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    throw new Error(DECRYPT_BODY_ENVELOPE_ERROR);
  }
}

export function unwrapEnvelopeKeyForRecipient(
  envelopeBase64: string,
  recipientPrivateKey: PrivateKeyInput,
): Buffer {
  const envelope = decodeCiphertextEnvelope(envelopeBase64);
  return unwrapAesKeyForRecipient(envelope.wrappedKey, recipientPrivateKey);
}

export function encodeCiphertextEnvelope(parts: CiphertextEnvelopeParts): string {
  const version = parts.version ?? ENVELOPE_VERSION;
  const wrappedKey = Buffer.from(parts.wrappedKey);
  const iv = Buffer.from(parts.iv);
  const ciphertextBody = Buffer.from(parts.ciphertextBody);
  const tag = Buffer.from(parts.tag);

  if (version !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported ciphertext envelope version: ${version}`);
  }

  if (wrappedKey.length > 0xffff) {
    throw new Error("wrapped_key exceeds 65535 bytes");
  }

  if (iv.length !== IV_BYTES) {
    throw new Error(`iv must be ${IV_BYTES} bytes`);
  }

  if (tag.length !== TAG_BYTES) {
    throw new Error(`tag must be ${TAG_BYTES} bytes`);
  }

  const wrappedKeyLength = Buffer.alloc(2);
  wrappedKeyLength.writeUInt16BE(wrappedKey.length, 0);

  return Buffer.concat([
    Buffer.from([version]),
    wrappedKeyLength,
    wrappedKey,
    iv,
    ciphertextBody,
    tag,
  ]).toString("base64");
}

export function decodeCiphertextEnvelope(envelopeBase64: string): DecodedCiphertextEnvelope {
  const raw = Buffer.from(envelopeBase64, "base64");

  if (raw.length < 1 + 2 + IV_BYTES + TAG_BYTES) {
    throw new Error("Ciphertext envelope is too short");
  }

  const version = raw[0];
  if (version !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported ciphertext envelope version: ${version}`);
  }

  const wrappedKeyLength = raw.readUInt16BE(1);
  const wrappedKeyStart = 3;
  const wrappedKeyEnd = wrappedKeyStart + wrappedKeyLength;
  const ivStart = wrappedKeyEnd;
  const ivEnd = ivStart + IV_BYTES;
  const tagStart = raw.length - TAG_BYTES;

  if (wrappedKeyEnd > tagStart - IV_BYTES) {
    throw new Error("Ciphertext envelope wrapped_key_length is invalid");
  }

  return {
    version,
    wrappedKey: raw.subarray(wrappedKeyStart, wrappedKeyEnd),
    iv: raw.subarray(ivStart, ivEnd),
    ciphertextBody: raw.subarray(ivEnd, tagStart),
    tag: raw.subarray(tagStart),
  };
}

function wrapAesKeyForRecipient(aesKey: Buffer, recipientPublicKey: PublicKeyInput): Buffer {
  const { publicKey: ephemeralPublicKey, privateKey: ephemeralPrivateKey } =
    generateKeyPairSync("x25519");
  const ephemeralPublicKeyDer = Buffer.from(
    ephemeralPublicKey.export({ format: "der", type: "spki" }),
  );
  const sharedSecret = diffieHellman({
    privateKey: ephemeralPrivateKey,
    publicKey: normalizePublicKey(recipientPublicKey),
  });
  const wrappingKey = deriveWrappingKey(sharedSecret);
  const wrapIv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, wrapIv);
  cipher.setAAD(WRAP_INFO);
  const wrappedBody = Buffer.concat([cipher.update(aesKey), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ephemeralLength = Buffer.alloc(WRAPPED_KEY_EPHEMERAL_LENGTH_BYTES);
  ephemeralLength.writeUInt16BE(ephemeralPublicKeyDer.length, 0);

  return Buffer.concat([ephemeralLength, ephemeralPublicKeyDer, wrapIv, wrappedBody, tag]);
}

function unwrapAesKeyForRecipient(
  wrappedKey: Buffer,
  recipientPrivateKey: PrivateKeyInput,
): Buffer {
  if (
    wrappedKey.length <
    WRAPPED_KEY_EPHEMERAL_LENGTH_BYTES + IV_BYTES + AES_KEY_BYTES + TAG_BYTES
  ) {
    throw new Error("Wrapped key payload is too short");
  }

  const ephemeralLength = wrappedKey.readUInt16BE(0);
  const ephemeralStart = WRAPPED_KEY_EPHEMERAL_LENGTH_BYTES;
  const ephemeralEnd = ephemeralStart + ephemeralLength;
  const wrapIvStart = ephemeralEnd;
  const wrapIvEnd = wrapIvStart + IV_BYTES;
  const tagStart = wrappedKey.length - TAG_BYTES;

  if (ephemeralEnd > tagStart - IV_BYTES) {
    throw new Error("Wrapped key payload has an invalid ephemeral key length");
  }

  const sharedSecret = diffieHellman({
    privateKey: normalizePrivateKey(recipientPrivateKey),
    publicKey: createPublicKey({
      key: wrappedKey.subarray(ephemeralStart, ephemeralEnd),
      format: "der",
      type: "spki",
    }),
  });
  const wrappingKey = deriveWrappingKey(sharedSecret);

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      wrappingKey,
      wrappedKey.subarray(wrapIvStart, wrapIvEnd),
    );
    decipher.setAAD(WRAP_INFO);
    decipher.setAuthTag(wrappedKey.subarray(tagStart));

    const aesKey = Buffer.concat([
      decipher.update(wrappedKey.subarray(wrapIvEnd, tagStart)),
      decipher.final(),
    ]);

    if (aesKey.length !== AES_KEY_BYTES) {
      throw new Error("Wrapped AES key length is invalid");
    }

    return aesKey;
  } catch {
    throw new Error("Failed to unwrap recipient AES key authentication");
  }
}

function deriveWrappingKey(sharedSecret: BinaryLike): Buffer {
  return Buffer.from(hkdfSync("sha256", sharedSecret, EMPTY_SALT, WRAP_INFO, AES_KEY_BYTES));
}

function normalizePublicKey(value: PublicKeyInput): KeyObject {
  if (isKeyObject(value)) return value;
  if (isRawX25519Key(value)) {
    return createPublicKey({
      key: {
        crv: "X25519",
        kty: "OKP",
        x: Buffer.from(value).toString("base64url"),
      },
      format: "jwk",
    });
  }

  return createPublicKey(value);
}

function normalizePrivateKey(value: PrivateKeyInput): KeyObject {
  if (isKeyObject(value)) return value;
  if (isRawX25519Key(value)) {
    return createPrivateKey({
      key: {
        crv: "X25519",
        d: Buffer.from(value).toString("base64url"),
        kty: "OKP",
        x: Buffer.from(generatePublicKeyFromRawPrivateKey(value)).toString("base64url"),
      },
      format: "jwk",
    });
  }

  return createPrivateKey(value);
}

function isKeyObject(value: unknown): value is KeyObject {
  return (
    typeof value === "object" && value !== null && "type" in value && "asymmetricKeyType" in value
  );
}

function isRawX25519Key(value: unknown): value is Buffer | Uint8Array {
  return value instanceof Uint8Array && value.byteLength === 32;
}

function generatePublicKeyFromRawPrivateKey(value: Uint8Array): Uint8Array {
  return x25519.getPublicKey(value);
}

function asBinary(value: string | Uint8Array): BinaryLike {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}
