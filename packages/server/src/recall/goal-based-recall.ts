import type { ChatClient, ChatMessage } from "../llm/client.js";
import type { EmbeddingClient } from "../embedding/client.js";
import type { SoulAnchor } from "../types.js";
import { RECALL_FULL_INJECTION_THRESHOLD } from "./constants.js";

export interface GoalBasedRecallOptions {
  chatClient: ChatClient;
  embeddingClient?: EmbeddingClient;
  goals: string[];
  context: string;
  initialAnchors?: SoulAnchor[];
  countAnchors(): Promise<number>;
  listAnchors(limit?: number): Promise<SoulAnchor[]>;
  searchAnchors(embedding: number[]): Promise<SoulAnchor[]>;
  buildJudgmentPrompt(args: {
    goals: string[];
    anchors: SoulAnchor[];
    context: string;
  }): ChatMessage[];
  parseJudgment(content: string): {
    sufficient: boolean;
    nextQuery?: string;
    narrative?: string;
  };
  onNarrative?: (text: string) => void;
  maxRounds?: number;
}

export interface GoalBasedRecallResult {
  anchors: SoulAnchor[];
  narratives: string[];
  rounds: number;
  sufficient: boolean;
  strategy: "full-injection" | "recall-loop";
}

export async function goalBasedRecall(
  options: GoalBasedRecallOptions,
): Promise<GoalBasedRecallResult> {
  const anchorCount = await options.countAnchors();

  if (anchorCount <= RECALL_FULL_INJECTION_THRESHOLD) {
    return {
      anchors: await options.listAnchors(),
      narratives: [],
      rounds: 0,
      sufficient: true,
      strategy: "full-injection",
    };
  }

  if (!options.embeddingClient) {
    throw new Error("Embedding client not configured for recall loop");
  }

  const allAnchors = new Map<string, SoulAnchor>();
  for (const anchor of options.initialAnchors ?? []) {
    allAnchors.set(anchor.id, anchor);
  }

  const narratives: string[] = [];
  let query = options.context;
  let rounds = 0;

  while (rounds < (options.maxRounds ?? 5)) {
    rounds += 1;

    const [embedding] = await options.embeddingClient.embed([query]);
    const foundAnchors = await options.searchAnchors(embedding);
    for (const anchor of foundAnchors) {
      allAnchors.set(anchor.id, anchor);
    }

    const messages = options.buildJudgmentPrompt({
      goals: options.goals,
      anchors: Array.from(allAnchors.values()),
      context: options.context,
    });
    const response = await options.chatClient.chat({ messages });
    const judgment = options.parseJudgment(response.content);

    if (judgment.narrative) {
      narratives.push(judgment.narrative);
      options.onNarrative?.(judgment.narrative);
    }

    if (judgment.sufficient) {
      return {
        anchors: Array.from(allAnchors.values()),
        narratives,
        rounds,
        sufficient: true,
        strategy: "recall-loop",
      };
    }

    if (!judgment.nextQuery) {
      break;
    }
    query = judgment.nextQuery;
  }

  return {
    anchors: Array.from(allAnchors.values()),
    narratives,
    rounds,
    sufficient: false,
    strategy: "recall-loop",
  };
}
