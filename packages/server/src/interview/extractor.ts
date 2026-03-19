import type { ChatClient, ChatMessage } from "../llm/client.js";
import type { SoulAnchor } from "../types.js";
import { buildExtractionPrompt } from "./prompts.js";
import { parseAllTagObjects } from "../llm/xml-parser.js";

export interface ExtractOptions {
  chatClient: ChatClient;
  userMessage: string;
  recentMessages: { role: string; content: string }[];
  existingAnchors: SoulAnchor[];
}

export async function extractAnchors(
  options: ExtractOptions,
): Promise<{ question: string; answer: string }[]> {
  try {
    const messages = buildExtractionPrompt(
      options.userMessage,
      options.recentMessages,
      options.existingAnchors,
    );
    const response = await options.chatClient.chat({
      messages: messages as ChatMessage[],
      temperature: 0,
    });

    const parsed = parseAllTagObjects(response.content, "anchor", ["question", "answer"]);
    return parsed.filter(
      (item): item is { question: string; answer: string } =>
        typeof item.question === "string" &&
        item.question.length > 0 &&
        typeof item.answer === "string" &&
        item.answer.length > 0,
    );
  } catch (err) {
    console.warn("extractAnchors failed:", err);
    return [];
  }
}
