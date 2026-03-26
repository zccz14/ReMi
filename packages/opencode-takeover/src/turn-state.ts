import type { AnchorStatus, SessionMessage, TurnState } from "./types.ts";

function isRunningTool(message: SessionMessage) {
  return message.parts.some(
    (part) =>
      part.type === "tool" &&
      "state" in part &&
      (part.state as { status?: string }).status === "running",
  );
}

function hasVisibleContent(message: SessionMessage) {
  return message.parts.some(
    (part) =>
      (part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) ||
      (part.type === "tool" && typeof part.tool === "string"),
  );
}

export function evaluateTurnState(
  messages: SessionMessage[],
  anchors: Map<string, AnchorStatus> = new Map(),
): TurnState {
  const tail = messages.at(-1);
  if (!tail) return { kind: "ambiguous", reason: "no messages" };
  if (tail.info.role !== "assistant") return { kind: "ambiguous", reason: "tail is not assistant" };
  if (isRunningTool(tail)) return { kind: "busy" };
  if (!tail.info.time.completed) return { kind: "busy" };
  if (!hasVisibleContent(tail))
    return { kind: "ambiguous", reason: "assistant has no visible content" };
  if (anchors.get(tail.info.id) === "committed") {
    return { kind: "ambiguous", reason: "assistant already processed" };
  }
  return { kind: "idle-runnable", anchorId: tail.info.id };
}
