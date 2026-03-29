import type { ChatClient, ChatMessage } from "../llm/client.js";
import type { SoulAnchor } from "../types.js";
import { canonicalizeQuestionDraft } from "../reasoning/question-canonicalization.js";
import { buildExtractionPrompt } from "./prompts.js";
import { parseAllTagObjects } from "../llm/xml-parser.js";
import { logger } from "../logger.js";

const log = logger.child({ module: "extractor" });

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
    const anchors = parsed
      .filter(
        (item): item is { question: string; answer: string } =>
          typeof item.question === "string" &&
          item.question.length > 0 &&
          typeof item.answer === "string" &&
          item.answer.length > 0,
      )
      .map((item) => ({
        question: canonicalizeQuestionDraft({
          draft: item.question,
          ownerVoice: "first-person",
        }).displayQuestion,
        answer: item.answer.trim(),
      }));

    log.info({ extracted: anchors.length }, "Anchors extracted from message");
    return anchors;
  } catch (err) {
    log.error({ err }, "extractAnchors failed");
    return [];
  }
}
