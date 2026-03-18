import { createHash } from "node:crypto";
import * as ed from "@noble/ed25519";
import { base58Encode, base58Decode } from "./base58.js";

// Configure sha512Sync for @noble/ed25519 v2 sync APIs (e.g. getPublicKey)
ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => {
  const hash = createHash("sha512");
  for (const m of messages) hash.update(m);
  return new Uint8Array(hash.digest());
};

export function generateKeyPair(): string {
  const privateKey = ed.utils.randomPrivateKey();
  return base58Encode(privateKey);
}

export function getPublicKey(privateKeyBase58: string): string {
  const privateKey = base58Decode(privateKeyBase58);
  const publicKey = ed.getPublicKey(privateKey);
  return base58Encode(publicKey);
}

export async function sign(
  message: Uint8Array,
  privateKeyBase58: string
): Promise<string> {
  const privateKey = base58Decode(privateKeyBase58);
  const signature = await ed.signAsync(message, privateKey);
  return base58Encode(signature);
}

export async function verify(
  message: Uint8Array,
  signatureBase58: string,
  publicKeyBase58: string
): Promise<boolean> {
  const signature = base58Decode(signatureBase58);
  const publicKey = base58Decode(publicKeyBase58);
  return ed.verifyAsync(signature, message, publicKey);
}
