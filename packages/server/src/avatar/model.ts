import { base58Decode } from "@remi/crypto";

export type AvatarInferenceMessageRole = "system" | "user" | "assistant";

export interface AvatarInferenceMessage {
  role: AvatarInferenceMessageRole;
  content: string;
}

export interface AvatarInferenceRequest {
  avatarTarget: { publicKey: string };
  instructionSegments: {
    platform: string;
    avatar: string;
    recall: string;
  };
  conversationTurns: AvatarInferenceMessage[];
  contentParts: [];
  stream: boolean;
  signal?: AbortSignal;
}

export interface AvatarInferenceResponse {
  message: { role: "assistant"; content: string };
  finishReason: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export type AvatarInferenceEvent =
  | { type: "message_start"; message: { role: "assistant" } }
  | { type: "text_delta"; text: string }
  | { type: "message_end"; finishReason: string };

export function parseAvatarModel(model: string): { publicKey: string; model: string } | null {
  if (!model.startsWith("ReMi-")) {
    return null;
  }

  const publicKey = model.slice(5);
  if (!publicKey) {
    return null;
  }

  try {
    if (base58Decode(publicKey).length !== 32) {
      return null;
    }
  } catch {
    return null;
  }

  return { publicKey, model };
}
