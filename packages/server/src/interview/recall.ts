import type { ChatClient, ChatMessage } from "../llm/client.js";
import type { SoulAnchor } from "../types.js";
import type { EmbeddingClient } from "../embedding/client.js";
import { buildRecallJudgmentPrompt } from "./prompts.js";
import { extractTag } from "../llm/xml-parser.js";

export interface RecallOptions {
  chatClient: ChatClient;
  embeddingClient: EmbeddingClient;
  searchAnchors: (embedding: number[]) => Promise<SoulAnchor[]>;
  context: string;
  goal: string;
  maxRounds?: number;
  topK?: number;
  onNarrative?: (text: string) => void;
}

export interface RecallResult {
  anchors: SoulAnchor[];
  narratives: string[];
  rounds: number;
  sufficient: boolean;
}

export async function agenticRecall(options: RecallOptions): Promise<RecallResult> {
  const {
    chatClient,
    embeddingClient,
    searchAnchors,
    context,
    goal,
    maxRounds = 5,
    onNarrative,
  } = options;

  const allAnchors = new Map<string, SoulAnchor>();
  const narratives: string[] = [];
  let query = context;
  let rounds = 0;

  while (rounds < maxRounds) {
    rounds++;

    // 向量搜索
    const [embedding] = await embeddingClient.embed([query]);
    const found = await searchAnchors(embedding);
    for (const anchor of found) {
      allAnchors.set(anchor.id, anchor);
    }

    // LLM 判断充分性
    const messages = buildRecallJudgmentPrompt(Array.from(allAnchors.values()), context, goal);
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
