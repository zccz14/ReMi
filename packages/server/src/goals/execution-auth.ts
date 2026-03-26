import { createHash, hkdfSync } from "node:crypto";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { base58Decode, base58Encode } from "@remi/crypto";

ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => {
  const hash = sha512.create();
  for (const message of messages) hash.update(message);
  return hash.digest();
};

const EXECUTION_INFO_PREFIX = new TextEncoder().encode("remi-exec-v1");

export interface DeriveExecutionSignerInput {
  rootSeed: string | Uint8Array;
  userIdentityPubkey: string;
}

export interface CreateExecutionSignedHeadersInput extends DeriveExecutionSignerInput {
  method: string;
  pathWithQuery: string;
  timestamp: string;
  nonce: string;
  body?: Uint8Array | null;
}

export interface ExecutionSigner {
  seed: Uint8Array;
  executionTrustPubkey: string;
}

export interface ExecutionCanonicalParts {
  method: string;
  pathWithQuery: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
}

function normalizeRootSeed(rootSeed: string | Uint8Array): Uint8Array {
  return typeof rootSeed === "string"
    ? new TextEncoder().encode(rootSeed)
    : new Uint8Array(rootSeed);
}

export async function hashExecutionBody(body?: Uint8Array | null): Promise<string> {
  const bytes = body && body.length > 0 ? body : new Uint8Array(0);
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildExecutionCanonicalString({
  method,
  pathWithQuery,
  timestamp,
  nonce,
  bodyHash,
}: ExecutionCanonicalParts): string {
  return `${method}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

export async function deriveExecutionSigner({
  rootSeed,
  userIdentityPubkey,
}: DeriveExecutionSignerInput): Promise<ExecutionSigner> {
  const userIdentityPubkeyBytes = base58Decode(userIdentityPubkey);
  const info = new Uint8Array(EXECUTION_INFO_PREFIX.length + userIdentityPubkeyBytes.length);
  info.set(EXECUTION_INFO_PREFIX, 0);
  info.set(userIdentityPubkeyBytes, EXECUTION_INFO_PREFIX.length);

  const seed = new Uint8Array(
    hkdfSync("sha256", normalizeRootSeed(rootSeed), new Uint8Array(0), info, 32),
  );
  const executionTrustPubkey = base58Encode(await ed.getPublicKeyAsync(seed));

  return { seed, executionTrustPubkey };
}

export async function createExecutionSignedHeaders({
  rootSeed,
  userIdentityPubkey,
  method,
  pathWithQuery,
  timestamp,
  nonce,
  body,
}: CreateExecutionSignedHeadersInput): Promise<Record<string, string>> {
  const { seed, executionTrustPubkey } = await deriveExecutionSigner({
    rootSeed,
    userIdentityPubkey,
  });
  const bodyHash = await hashExecutionBody(body);
  const canonical = buildExecutionCanonicalString({
    method,
    pathWithQuery,
    timestamp,
    nonce,
    bodyHash,
  });
  const signatureBytes = await ed.signAsync(new TextEncoder().encode(canonical), seed);

  return {
    "X-Remi-Timestamp": timestamp,
    "X-Remi-Nonce": nonce,
    "X-Remi-Body-SHA256": bodyHash,
    "X-Remi-Signature": Buffer.from(signatureBytes).toString("base64"),
    "X-Remi-Execution-Pubkey": executionTrustPubkey,
  };
}
