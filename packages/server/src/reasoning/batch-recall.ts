import type { ChatClient, ChatMessage } from "../llm/client.js";
import type { SoulAnchor } from "../types.js";
import type { EmbeddingClient } from "../embedding/client.js";
import { buildBatchRecallJudgmentPrompt } from "./prompts.js";
import { extractTag } from "../llm/xml-parser.js";

export interface BatchRecallOptions {
  chatClient: ChatClient;
  embeddingClient: EmbeddingClient;
  searchAnchors: (embedding: number[]) => Promise<SoulAnchor[]>;
  goals: string[];
  context: string;
  visitorKey: string;
  cachedAnchors?: SoulAnchor[];
  maxRounds?: number;
  onNarrative?: (text: string) => void;
}

export interface BatchRecallResult {
  anchors: SoulAnchor[];
  narratives: string[];
  rounds: number;
  sufficient: boolean;
}

export async function batchRecall(options: BatchRecallOptions): Promise<BatchRecallResult> {
  const {
    chatClient,
    embeddingClient,
    searchAnchors,
    goals,
    context,
    visitorKey,
    cachedAnchors = [],
    maxRounds = 5,
    onNarrative,
  } = options;

  const allAnchors = new Map<string, SoulAnchor>();
  for (const anchor of cachedAnchors) {
    allAnchors.set(anchor.id, anchor);
  }
  const narratives: string[] = [];
  let query = context;
  let rounds = 0;

  while (rounds < maxRounds) {
    rounds++;

    const [embedding] = await embeddingClient.embed([query]);
    const found = await searchAnchors(embedding);
    for (const anchor of found) {
      allAnchors.set(anchor.id, anchor);
    }

    const messages = buildBatchRecallJudgmentPrompt(
      goals,
      Array.from(allAnchors.values()),
      context,
      visitorKey,
    );
    const response = await chatClient.chat({
      messages: messages as ChatMessage[],
      temperature: 0,
    });

    const content = response.content;
    const judgmentBlock = extractTag(content, "judgment");
    if (!judgmentBlock) {
      break;
    }

    const sufficient = extractTag(judgmentBlock, "sufficient")?.toLowerCase() === "true";
    const nextQuery = extractTag(judgmentBlock, "next_query");
    const narrative = extractTag(judgmentBlock, "narrative");

    if (narrative) {
      narratives.push(narrative);
      onNarrative?.(narrative);
    }

    if (sufficient) {
      return {
        anchors: Array.from(allAnchors.values()),
        narratives,
        rounds,
        sufficient: true,
      };
    }

    if (nextQuery) {
      query = nextQuery;
    } else {
      break;
    }
  }

  return {
    anchors: Array.from(allAnchors.values()),
    narratives,
    rounds,
    sufficient: false,
  };
}
