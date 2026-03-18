export type Role = "owner" | "visitor";

export function determineRole(
  signerPublicKey: string,
  targetPublicKey: string
): Role {
  return signerPublicKey === targetPublicKey ? "owner" : "visitor";
}
