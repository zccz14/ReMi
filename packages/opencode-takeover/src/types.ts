export interface MessageInfo {
  id: string;
  role: "user" | "assistant" | "system";
  time: {
    created: number;
    completed?: number;
  };
}

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolPart {
  type: "tool";
  tool: string;
  state: {
    status: string;
  };
}

export interface GenericPart {
  type: string;
  [key: string]: unknown;
}

export type SessionPart = TextPart | ToolPart | GenericPart;

export interface SessionMessage {
  info: MessageInfo;
  parts: SessionPart[];
}

export interface MirroredMessage {
  role: "user" | "assistant";
  content: string;
}

export type AnchorStatus = "write_pending" | "committed";

export type TurnState =
  | { kind: "busy" }
  | { kind: "ambiguous"; reason: string }
  | { kind: "idle-runnable"; anchorId: string };
