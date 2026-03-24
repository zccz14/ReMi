import type { ChatClient, ChatMessage } from "../llm/client.js";
import type { SoulAnchor } from "../types.js";
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

function normalizeOwnerQuestion(question: string): string {
  let normalized = question.trim();

  normalized = normalized.replace(/用户的/g, "我的");
  normalized = normalized.replace(/用户最近在/g, "我最近在");
  normalized = normalized.replace(/用户最近/g, "我最近");
  normalized = normalized.replace(/用户现在在/g, "我现在在");
  normalized = normalized.replace(/用户现在/g, "我现在");
  normalized = normalized.replace(/用户在/g, "我在");
  normalized = normalized.replace(/用户/g, "我");

  normalized = normalized.replace(
    /^我在(?:上周[一二三四五六日天]?|本周|这周|昨天|今天|刚才|当时|前天)?(?:上午|中午|下午|晚上)?/,
    "我最近在",
  );
  normalized = normalized.replace(/具体/g, "");
  normalized = normalized.replace(/经历了什么/g, "经历什么");
  normalized = normalized.replace(/我在经历什么/g, "我最近在经历什么");
  normalized = normalized.replace(/我在做什么/g, "我现在在做什么");
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized;
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
        question: normalizeOwnerQuestion(item.question),
        answer: item.answer.trim(),
      }));

    log.info({ extracted: anchors.length }, "Anchors extracted from message");
    return anchors;
  } catch (err) {
    log.error({ err }, "extractAnchors failed");
    return [];
  }
}
