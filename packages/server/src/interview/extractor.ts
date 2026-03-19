import type { ChatClient, ChatMessage } from "../llm/client.js";
import type { SoulAnchor } from "../types.js";
import { buildExtractionPrompt } from "./prompts.js";

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
      responseFormat: { type: "json_object" },
    });
    const parsed = JSON.parse(response.content);
    const anchors = parsed.anchors ?? parsed;
    if (Array.isArray(anchors)) {
      return anchors.filter(
        (item: unknown): item is { question: string; answer: string } =>
          typeof item === "object" &&
          item !== null &&
          "question" in item &&
          typeof (item as Record<string, unknown>).question === "string" &&
          "answer" in item &&
          typeof (item as Record<string, unknown>).answer === "string",
      );
    }
    return [];
  } catch {
    return [];
  }
}
