import type { ChatClient, ChatMessage } from "../llm/client.js";
import type { SoulAnchor } from "../types.js";
import { buildContradictionPrompt } from "./prompts.js";

export interface Contradiction {
  newAnchor: string;
  existingAnchor: string;
  description: string;
}

export interface ContradictionOptions {
  chatClient: ChatClient;
  newAnchors: { question: string; answer: string }[];
  existingAnchors: SoulAnchor[];
}

export async function detectContradictions(
  options: ContradictionOptions,
): Promise<Contradiction[]> {
  if (options.newAnchors.length === 0) return [];

  try {
    const messages = buildContradictionPrompt(options.newAnchors, options.existingAnchors);
    const response = await options.chatClient.chat({
      messages: messages as ChatMessage[],
      temperature: 0,
      responseFormat: { type: "json_object" },
    });
    const parsed = JSON.parse(response.content);
    if (parsed.contradictions && Array.isArray(parsed.contradictions)) {
      return parsed.contradictions;
    }
    return [];
  } catch {
    return [];
  }
}
