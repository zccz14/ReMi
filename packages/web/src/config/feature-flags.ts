export type ConversationFlowMode = "full" | "observability-only" | "off";

const VALID_MODES: ConversationFlowMode[] = ["full", "observability-only", "off"];

export function getConversationFlowMode(): ConversationFlowMode {
  const value = (import.meta.env as Record<string, unknown>).REMI_CONVERSATION_FLOW_V2;
  if (typeof value === "string" && VALID_MODES.includes(value as ConversationFlowMode)) {
    return value as ConversationFlowMode;
  }
  return "off";
}
