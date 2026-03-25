import { base58Encode } from "./base58";

export async function hashBody(body?: Uint8Array): Promise<string> {
  const data = body ?? new Uint8Array(0);
  const digestInput = new Uint8Array(data);
  const hash = await crypto.subtle.digest("SHA-256", digestInput);
  return base58Encode(new Uint8Array(hash));
}

export async function buildStringToSign(
  method: string,
  pathname: string,
  timestamp: string,
  body?: Uint8Array,
): Promise<string> {
  const bodyHash = await hashBody(body);
  return `${method}\n${pathname}\n${timestamp}\n${bodyHash}`;
}
