import { createHash } from "node:crypto";
import { base58Decode } from "@remi/crypto";
import { edwardsToMontgomeryPub, x25519 } from "@noble/curves/ed25519";

import { canonicalizeBodyJson } from "./body.js";
import { decryptBodyEnvelope, encryptBodyForRecipient } from "./crypto.js";

const PLATFORM_SECRET =
  process.env.REMI_DIRECT_MESSAGE_PLATFORM_SECRET ??
  (process.env.NODE_ENV === "test" ? "remi.direct-message-platform.v1" : null);

if (!PLATFORM_SECRET) {
  throw new Error("REMI_DIRECT_MESSAGE_PLATFORM_SECRET must be configured outside tests");
}

const PLATFORM_KEY_MATERIAL = createHash("sha256").update(PLATFORM_SECRET).digest().subarray(0, 32);
const platformPrivateKey = Uint8Array.from(PLATFORM_KEY_MATERIAL);
const platformPublicKey = x25519.getPublicKey(platformPrivateKey);

export interface StoredBody {
  type: string;
  version: number;
  text?: string;
  content?: string;
  [key: string]: unknown;
}

export function encryptStoredBody(
  body: StoredBody,
  recipientPubKeys: { partyAKey: string; partyBKey: string },
): {
  bodyJson: StoredBody;
  ciphertextA: string;
  ciphertextB: string;
  ciphertextC: string;
} {
  const canonicalBody = canonicalizeBodyJson(body);
  const normalizedBody = JSON.parse(canonicalBody) as StoredBody;
  const recipientAKey = edwardsToMontgomeryPub(base58Decode(recipientPubKeys.partyAKey));
  const recipientBKey = edwardsToMontgomeryPub(base58Decode(recipientPubKeys.partyBKey));

  return {
    bodyJson: normalizedBody,
    ciphertextA: encryptBodyForRecipient(canonicalBody, recipientAKey),
    ciphertextB: encryptBodyForRecipient(canonicalBody, recipientBKey),
    ciphertextC: encryptBodyForRecipient(canonicalBody, platformPublicKey),
  };
}

export function decodeStoredBody(ciphertext: string): StoredBody | null {
  try {
    const plaintext = decryptBodyEnvelope(ciphertext, platformPrivateKey);
    const parsed = JSON.parse(plaintext);
    return isStoredBody(parsed) ? parsed : null;
  } catch {
    return decodeLegacyStoredBody(ciphertext);
  }
}

export function assertCiphertextHealthy(ciphertext: string): void {
  const body = decodeStoredBody(ciphertext);
  if (!body) {
    throw new Error("Failed to decrypt stored body");
  }
}

export function extractStoredBodyText(body: StoredBody | null): string {
  if (!body) return "";
  if (typeof body.text === "string") return body.text;
  if (typeof body.content === "string") return body.content;
  return "";
}

function decodeLegacyStoredBody(ciphertext: string): StoredBody | null {
  for (const candidate of [ciphertext, decodeBase64Utf8(ciphertext)]) {
    if (!candidate) continue;

    try {
      const parsed = JSON.parse(candidate);
      if (isStoredBody(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next legacy candidate.
    }
  }

  const decoded = decodeBase64Utf8(ciphertext) ?? ciphertext;
  if (!decoded || !isLikelyPlainText(decoded)) {
    return null;
  }

  return { type: "text", version: 1, text: decoded };
}

function decodeBase64Utf8(input: string): string | null {
  try {
    const decoded = Buffer.from(input, "base64").toString("utf8");
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function isStoredBody(value: unknown): value is StoredBody {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StoredBody).type === "string" &&
    typeof (value as StoredBody).version === "number"
  );
}

function isLikelyPlainText(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      return false;
    }
  }

  return true;
}
