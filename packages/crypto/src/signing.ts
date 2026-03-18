import { base58Encode } from "./base58.js";

export async function hashBody(
  body: Uint8Array | undefined | null
): Promise<string> {
  const data = body && body.length > 0 ? body : new Uint8Array(0);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base58Encode(new Uint8Array(hash));
}

export async function buildStringToSign(
  method: string,
  path: string,
  timestamp: string,
  body: Uint8Array | undefined | null
): Promise<string> {
  const bodyHash = await hashBody(body);
  return `${method}\n${path}\n${timestamp}\n${bodyHash}`;
}
