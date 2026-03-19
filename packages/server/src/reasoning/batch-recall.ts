import type { ChatClient, ChatMessage } from "../llm/client.js";
import type { SoulAnchor } from "../types.js";
import type { EmbeddingClient } from "../embedding/client.js";
import { buildBatchRecallJudgmentPrompt } from "./prompts.js";
import { extractTag } from "../llm/xml-parser.js";
import { logger, shortKey } from "../logger.js";

const log = logger.child({ module: "batch-recall" });

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

  log.info(
    {
      goalCount: goals.length,
      cachedAnchors: cachedAnchors.length,
      visitor: shortKey(visitorKey),
      maxRounds,
    },
    "Batch recall started",
  );

  while (rounds < maxRounds) {
    rounds++;

    const [embedding] = await embeddingClient.embed([query]);
    const found = await searchAnchors(embedding);
    for (const anchor of found) {
      allAnchors.set(anchor.id, anchor);
    }

    log.debug(
      { round: rounds, foundThisRound: found.length, totalAnchors: allAnchors.size },
      "Batch recall round completed",
    );

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
      log.warn({ round: rounds }, "Batch recall judgment block missing, stopping");
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
      log.info(
        { rounds, totalAnchors: allAnchors.size, sufficient: true },
        "Batch recall finished",
      );
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
      log.debug({ round: rounds }, "No next query, stopping batch recall");
      break;
    }
  }

  log.info({ rounds, totalAnchors: allAnchors.size, sufficient: false }, "Batch recall finished");

  return {
    anchors: Array.from(allAnchors.values()),
    narratives,
    rounds,
    sufficient: false,
  };
}
