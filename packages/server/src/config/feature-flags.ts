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

export function isReasoningGapProbeEnabledForOwner(_ownerKey: string): boolean {
  return true;
}
