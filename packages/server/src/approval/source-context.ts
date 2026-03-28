import type { SoulAnchorSource } from "../types.js";

export interface SourceContextInput {
  source: SoulAnchorSource;
  sourceRef?: string | null;
  sourceSnapshot?: string | Record<string, unknown> | null;
}

export interface SourceContext {
  source: SoulAnchorSource;
  sourceRef: string | null;
  sourceSnapshot: string | null;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function buildSourceContext(input: SourceContextInput): SourceContext {
  const sourceSnapshot =
    typeof input.sourceSnapshot === "string"
      ? normalizeOptionalText(input.sourceSnapshot)
      : input.sourceSnapshot
        ? JSON.stringify(input.sourceSnapshot)
        : null;

  return {
    source: input.source,
    sourceRef: normalizeOptionalText(input.sourceRef),
    sourceSnapshot,
  };
}
