import type { MirroredMessage, SessionMessage, SessionPart } from "./types.ts";

function partText(part: SessionPart) {
  if (part.type === "text" && typeof part.text === "string") {
    return part.text;
  }
  if (part.type === "tool" && typeof part.tool === "string" && "state" in part) {
    return `[tool:${part.tool}:${String((part.state as { status?: string }).status ?? "unknown")}]`;
  }
  return null;
}

function mirroredRole(role: "user" | "assistant" | "system") {
  if (role === "assistant") return "user" as const;
  if (role === "user") return "assistant" as const;
  return null;
}

export function mirrorMessages(messages: SessionMessage[]): MirroredMessage[] {
  return messages
    .map((message) => {
      const role = mirroredRole(message.info.role);
      if (!role) return null;
      const content = message.parts
        .map(partText)
        .filter((item): item is string => Boolean(item))
        .join("\n\n")
        .trim();
      if (!content) return null;
      return { role, content };
    })
    .filter((item): item is MirroredMessage => Boolean(item));
}
