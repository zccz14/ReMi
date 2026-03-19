import type { ChatClient, ChatMessage } from "../llm/client.js";
import type { SoulAnchor } from "../types.js";
import { buildContradictionPrompt } from "./prompts.js";
import { parseAllTagObjects } from "../llm/xml-parser.js";

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
    });

    const parsed = parseAllTagObjects(response.content, "contradiction", [
      "new_anchor",
      "existing_anchor",
      "description",
    ]);

    return parsed
      .filter((item) => item.new_anchor && item.existing_anchor && item.description)
      .map((item) => ({
        newAnchor: item.new_anchor!,
        existingAnchor: item.existing_anchor!,
        description: item.description!,
      }));
  } catch (err) {
    console.warn("detectContradictions failed:", err);
    return [];
  }
}
