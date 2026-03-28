import type { SoulAssetKind } from "../types.js";

export function normalizeQuestion(input: string): string {
  const normalized = input.trim();
  if (!normalized) {
    throw new Error("Question is required");
  }
  return normalized;
}

export function normalizeAnswer(input: string | null | undefined): string | null {
  if (input == null) {
    return null;
  }

  const normalized = input.trim();
  return normalized ? normalized : null;
}

export function getSoulAssetKind(input: { answer: string | null }): SoulAssetKind {
  return input.answer === null ? "probe" : "anchor";
}
