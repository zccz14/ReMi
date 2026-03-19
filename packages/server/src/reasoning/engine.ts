import type { ChatClient, ChatMessage } from "../llm/client.js";
import type { EmbeddingClient } from "../embedding/client.js";
import type { SoulAnchor } from "../types.js";
import { batchRecall } from "./batch-recall.js";
import { buildAvatarSystemPrompt } from "./prompts.js";
import { logger, shortKey } from "../logger.js";

const log = logger.child({ module: "reasoning" });

export interface ReasoningSSEEmitter {
  emitThinking(narrative: string): void | Promise<void>;
  emitToken(content: string): void | Promise<void>;
  emitDone(data: { messageId: number; recalledAnchors: string[] }): void | Promise<void>;
  emitError(code: string, message: string): void | Promise<void>;
}

export interface ReasoningEngineDeps {
  chatClient: ChatClient;
  embeddingClient: EmbeddingClient;
  getMessages(
    visitorKey: string,
    limit: number,
  ): Promise<{ id: number; role: "user" | "assistant"; content: string }[]>;
  saveMessage(
    visitorKey: string,
    role: "user" | "assistant",
    content: string,
    recalledAnchors?: string[],
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

      const cachedIds = await this.deps.getCachedAnchorIds(visitorKey);
      const cachedAnchors = cachedIds.length > 0 ? await this.deps.getAnchorsByIds(cachedIds) : [];

      log.debug(
        { messageCount: messages.length, cachedAnchors: cachedAnchors.length },
        "Reasoning context loaded",
      );

      const contextStr = messages
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n")
        .slice(-2000);

      const recall = await batchRecall({
        chatClient: this.deps.chatClient,
        embeddingClient: this.deps.embeddingClient,
        searchAnchors: (emb) => this.deps.searchAnchors(emb),
        goals: DEFAULT_GOALS,
        context: contextStr,
        visitorKey,
        cachedAnchors,
        onNarrative: (n) => emitter.emitThinking(n),
      });

      const systemPrompt = buildAvatarSystemPrompt(recall.anchors);
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

      const anchorIds = recall.anchors.map((a) => a.id);
      const messageId = await this.deps.saveMessage(
        visitorKey,
        "assistant",
        fullContent,
        anchorIds,
      );

      const ms = Date.now() - startTime;
      log.info(
        { messageId, recalledAnchors: anchorIds.length, ms },
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
