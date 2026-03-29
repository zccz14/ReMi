export type ConversationFlowMode = "full" | "observability-only" | "off";

const VALID_MODES: ConversationFlowMode[] = ["full", "observability-only", "off"];

export function getConversationFlowMode(): ConversationFlowMode {
  const value = process.env.REMI_CONVERSATION_FLOW_V2;
  if (!value) return "off";
  if (VALID_MODES.includes(value as ConversationFlowMode)) {
    return value as ConversationFlowMode;
  }
  return "off";
}

function parseOwnerAllowlist(raw: string | undefined): Set<string> {
  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function isReasoningGapProbeEnabledForOwner(ownerKey: string): boolean {
  return parseOwnerAllowlist(process.env.REMI_REASONING_GAP_PROBE_OWNERS).has(ownerKey);
}
