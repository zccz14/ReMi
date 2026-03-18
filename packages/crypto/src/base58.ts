import baseX from "base-x";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const bs58 = baseX(ALPHABET);

export function base58Encode(data: Uint8Array): string {
  return bs58.encode(data);
}

export function base58Decode(str: string): Uint8Array {
  return bs58.decode(str);
}
