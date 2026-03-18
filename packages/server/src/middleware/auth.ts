import { verify, buildStringToSign } from "@remi/crypto";

export type AuthError = "MISSING_AUTH_HEADER" | "TIMESTAMP_EXPIRED" | "INVALID_SIGNATURE";

type AuthResult =
  | { ok: true; publicKey: string }
  | { ok: false; error: AuthError; message: string };

interface RequestInfo {
  method: string;
  path: string;
  timestamp: string | undefined;
  publicKey: string | undefined;
  signature: string | undefined;
  body: Uint8Array | undefined | null;
}

const MAX_TIMESTAMP_DRIFT_MS = 30_000;

export async function verifyRequest(req: RequestInfo): Promise<AuthResult> {
  if (!req.publicKey || !req.timestamp || !req.signature) {
    return {
      ok: false,
      error: "MISSING_AUTH_HEADER",
      message: "Missing required auth headers",
    };
  }

  const drift = Math.abs(Date.now() - Number(req.timestamp));
  if (drift > MAX_TIMESTAMP_DRIFT_MS) {
    return {
      ok: false,
      error: "TIMESTAMP_EXPIRED",
      message: "Timestamp outside acceptable window",
    };
  }

  const sts = await buildStringToSign(req.method, req.path, req.timestamp, req.body);

  let valid: boolean;
  try {
    valid = await verify(new TextEncoder().encode(sts), req.signature, req.publicKey);
  } catch {
    valid = false;
  }

  if (!valid) {
    return {
      ok: false,
      error: "INVALID_SIGNATURE",
      message: "Signature verification failed",
    };
  }

  return { ok: true, publicKey: req.publicKey };
}
