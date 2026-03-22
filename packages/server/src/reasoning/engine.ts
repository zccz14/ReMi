import type { ChatClient, ChatMessage } from "../llm/client.js";
import type { EmbeddingClient } from "../embedding/client.js";
import type { SoulAnchor } from "../types.js";
import { goalBasedRecall } from "../recall/goal-based-recall.js";
import { buildAvatarSystemPrompt } from "./prompts.js";
import { logger, shortKey } from "../logger.js";
import {
  REASONING_FULL_INJECTION_THRESHOLD,
  mapRecallRuntimeStrategyToReasoningStrategy,
  type ReasoningAnchorSelectionStrategy,
} from "./constants.js";
import { buildBatchRecallJudgmentPrompt } from "./prompts.js";
import { extractTag } from "../llm/xml-parser.js";

const log = logger.child({ module: "reasoning" });

export interface ReasoningSSEEmitter {
  emitThinking(narrative: string): void | Promise<void>;
  emitToken(content: string): void | Promise<void>;
  emitDone(data: { messageId: number; recalledAnchors: string[] }): void | Promise<void>;
  emitError(code: string, message: string): void | Promise<void>;
}

export interface ReasoningEngineDeps {
  chatClient: ChatClient;
  embeddingClient?: EmbeddingClient;
  countAnchors(): Promise<number>;
  listAnchors(limit?: number): Promise<SoulAnchor[]>;
  getMessages(
    visitorKey: string,
    limit: number,
  ): Promise<{ id: number; role: "user" | "assistant"; content: string }[]>;
  saveMessage(
    visitorKey: string,
    role: "user" | "assistant",
    content: string,
    recalledAnchors?: string[],
    anchorSelectionStrategy?: ReasoningAnchorSelectionStrategy,
  ): Promise<number>;
  searchAnchors(embedding: number[]): Promise<SoulAnchor[]>;
  getCachedAnchorIds(visitorKey: string): Promise<string[]>;
  getAnchorsByIds(ids: string[]): Promise<SoulAnchor[]>;
}

const WINDOW_SIZE = 20;

const DEFAULT_GOALS = [
  "我是谁，我的身份和表达风格",
  "对方是谁，我与对方的关系和沟通边界",
  "回答提问者的问题所需的认知",
];

export class ReasoningEngine {
  constructor(private deps: ReasoningEngineDeps) {}

  private parseRecallJudgment(content: string): {
    sufficient: boolean;
    nextQuery?: string;
    narrative?: string;
  } {
    const judgmentBlock = extractTag(content, "judgment");
    if (!judgmentBlock) {
      return { sufficient: false };
    }

    return {
      sufficient: extractTag(judgmentBlock, "sufficient")?.toLowerCase() === "true",
      nextQuery: extractTag(judgmentBlock, "next_query") ?? undefined,
      narrative: extractTag(judgmentBlock, "narrative") ?? undefined,
    };
  }

  async handleMessage(
    content: string,
    visitorKey: string,
    emitter: ReasoningSSEEmitter,
  ): Promise<void> {
    const startTime = Date.now();
    log.info({ visitor: shortKey(visitorKey) }, "Reasoning message flow initiated");

    try {
      await this.deps.saveMessage(visitorKey, "user", content);
      const messages = await this.deps.getMessages(visitorKey, WINDOW_SIZE);
      const anchorCount = await this.deps.countAnchors();
      log.debug({ messageCount: messages.length, anchorCount }, "Reasoning context loaded");

      const contextStr = messages
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n")
        .slice(-2000);

      const cachedAnchors =
        anchorCount > REASONING_FULL_INJECTION_THRESHOLD
          ? (() => this.deps.getCachedAnchorIds(visitorKey))().then((cachedIds) =>
              cachedIds.length > 0 ? this.deps.getAnchorsByIds(cachedIds) : Promise.resolve([]),
            )
          : Promise.resolve([] as SoulAnchor[]);
      const recall = await goalBasedRecall({
        chatClient: this.deps.chatClient,
        embeddingClient: this.deps.embeddingClient,
        goals: DEFAULT_GOALS,
        context: contextStr,
        initialAnchors: await cachedAnchors,
        countAnchors: () => this.deps.countAnchors(),
        listAnchors: (limit?: number) => this.deps.listAnchors(limit),
        searchAnchors: (emb) => this.deps.searchAnchors(emb),
        buildJudgmentPrompt: ({ goals, anchors, context }) =>
          buildBatchRecallJudgmentPrompt(goals, anchors, context, visitorKey) as ChatMessage[],
        parseJudgment: (value) => this.parseRecallJudgment(value),
        onNarrative: (n) => emitter.emitThinking(n),
      });

      const selectedAnchors = recall.anchors;
      const anchorSelectionStrategy = mapRecallRuntimeStrategyToReasoningStrategy(recall.strategy);

      const systemPrompt = buildAvatarSystemPrompt(selectedAnchors);
      const chatMessages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      ];

      let fullContent = "";
      for await (const token of this.deps.chatClient.chatStream({
        messages: chatMessages,
      })) {
        fullContent += token;
        await emitter.emitToken(token);
      }

      const anchorIds = selectedAnchors.map((a) => a.id);
      const messageId = await this.deps.saveMessage(
        visitorKey,
        "assistant",
        fullContent,
        anchorIds,
        anchorSelectionStrategy,
      );

      const ms = Date.now() - startTime;
      log.info(
        {
          messageId,
          recalledAnchors: anchorIds.length,
          selectionStrategy: anchorSelectionStrategy,
          anchorCount,
          promptChars: systemPrompt.length,
          ms,
        },
        "Reasoning message flow completed",
      );

      await emitter.emitDone({
        messageId,
        recalledAnchors: anchorIds,
      });
    } catch (error) {
      const ms = Date.now() - startTime;
      log.error({ err: error, ms }, "Reasoning message flow failed");
      await emitter.emitError(
        "LLM_ERROR",
        error instanceof Error ? error.message : "Unknown error",
      );
    }
  }
}
