import type { ChatClient, ChatMessage } from "../llm/client.js";
import type { EmbeddingClient } from "../embedding/client.js";
import type { SoulAnchor } from "../types.js";
import { extractAnchors } from "./extractor.js";
import { goalBasedRecall } from "../recall/goal-based-recall.js";
import { detectContradictions } from "./contradiction.js";
import { buildInterviewerSystemPrompt, buildRecallJudgmentPrompt } from "./prompts.js";
import { logger } from "../logger.js";
import { getConversationFlowMode } from "../config/feature-flags.js";
import { INTERVIEW_RECALL_GOALS } from "./constants.js";
import { extractTag } from "../llm/xml-parser.js";

const log = logger.child({ module: "interview" });

export interface SSEEmitter {
  emitThinking(narrative: string): void | Promise<void>;
  emitToken(content: string): void | Promise<void>;
  emitDone(data: { messageId: number; anchorsExtracted: number }): void | Promise<void>;
  emitError(code: string, message: string): void | Promise<void>;
  emitPhase(data: { phase: string; label?: string }): void | Promise<void>;
}

export interface EngineDeps {
  chatClient: ChatClient;
  embeddingClient: EmbeddingClient;
  cleanupEmptyAssistantMessages(): Promise<number>;
  getMessages(
    limit: number,
  ): Promise<
    { id: number; role: "user" | "assistant" | "system"; content: string; created_at: number }[]
  >;
  saveMessage(role: "user" | "assistant", content: string): Promise<number>;
  getAnchors(limit: number): Promise<SoulAnchor[]>;
  saveAnchors(anchors: { question: string; answer: string }[]): Promise<void>;
  searchAnchors(embedding: number[]): Promise<SoulAnchor[]>;
  getAnchorCount(): Promise<number>;
}

const WINDOW_SIZE = 20;
type ConversationPhase = "bootstrapping" | "extracting" | "recalling" | "detecting" | "generating";

function isSystemRoleUnsupportedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("invalid message role: system");
}

function downgradeSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const systemMessages = messages.filter((m) => m.role === "system").map((m) => m.content.trim());
  const nonSystemMessages = messages.filter((m) => m.role !== "system");
  const systemPrompt = systemMessages.filter(Boolean).join("\n\n");

  if (!systemPrompt) {
    return nonSystemMessages;
  }

  if (nonSystemMessages.length === 0 || nonSystemMessages[0].role !== "user") {
    return [{ role: "user", content: systemPrompt }, ...nonSystemMessages];
  }

  return [
    {
      role: "user",
      content: `${systemPrompt}\n\n${nonSystemMessages[0].content}`,
    },
    ...nonSystemMessages.slice(1),
  ];
}

function shouldInjectInterviewFailure(stage: "extract" | "detect"): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.REMI_INJECT_INTERVIEW_FAILURE === stage;
}

export class InterviewEngine {
  constructor(private deps: EngineDeps) {}

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

  private async chatFallback(messages: ChatMessage[]): Promise<string> {
    try {
      const fallback = await this.deps.chatClient.chat({ messages });
      return fallback.content;
    } catch (error) {
      if (!isSystemRoleUnsupportedError(error)) {
        throw error;
      }

      const downgraded = downgradeSystemMessages(messages);
      log.warn("Provider rejected system role, retrying fallback chat with downgraded messages");
      const retry = await this.deps.chatClient.chat({ messages: downgraded });
      return retry.content;
    }
  }

  async start(emitter: SSEEmitter): Promise<void> {
    const startTime = Date.now();
    const mode = getConversationFlowMode();
    const phaseEnabled = mode !== "off";
    const emitPhase = async (phase: ConversationPhase, label?: string): Promise<void> => {
      if (!phaseEnabled) return;
      await emitter.emitPhase({ phase, label });
    };
    log.info("Interview start flow initiated");

    try {
      const cleaned = await this.deps.cleanupEmptyAssistantMessages();
      if (cleaned > 0) {
        log.warn({ cleaned }, "Removed empty assistant replies before interview start");
      }

      await emitPhase("bootstrapping");
      const messages = await this.deps.getMessages(WINDOW_SIZE);
      const anchorCount = await this.deps.getAnchorCount();
      log.debug({ messageCount: messages.length, anchorCount }, "Interview context loaded");

      // Agentic Recall
      await emitPhase("recalling");
      const recall = await goalBasedRecall({
        chatClient: this.deps.chatClient,
        embeddingClient: this.deps.embeddingClient,
        goals: [...INTERVIEW_RECALL_GOALS],
        searchAnchors: (emb) => this.deps.searchAnchors(emb),
        countAnchors: () => this.deps.getAnchorCount(),
        listAnchors: (limit?: number) => this.deps.getAnchors(limit ?? 200),
        buildJudgmentPrompt: ({ goals, anchors, context }) =>
          buildRecallJudgmentPrompt(anchors, context, goals) as ChatMessage[],
        parseJudgment: (value) => this.parseRecallJudgment(value),
        context:
          messages
            .map((m) => `${m.role}: ${m.content}`)
            .join("\n")
            .slice(-2000) || "新用户，第一次对话",
        onNarrative: (n) => emitter.emitThinking(n),
      });
      await emitPhase("recalling", `${recall.anchors.length}`);

      // 生成回复
      await emitPhase("generating");
      const systemPrompt = buildInterviewerSystemPrompt(recall.anchors, [], anchorCount);
      const chatMessages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ];

      if (messages.length === 0) {
        chatMessages.push({
          role: "user",
          content: "这是第一次对话，请用冷启动协议开场：声明边界，给选择权，用轻量级问题。",
        });
      } else {
        chatMessages.push({
          role: "user",
          content: "用户回来继续对话，请生成一条恢复衔接消息。",
        });
      }

      let fullContent = "";
      for await (const token of this.deps.chatClient.chatStream({ messages: chatMessages })) {
        fullContent += token;
        await emitter.emitToken(token);
      }

      if (!fullContent.trim()) {
        log.warn("Interview start stream returned empty content, falling back to non-stream chat");
        fullContent = await this.chatFallback(chatMessages);
        if (fullContent) {
          await emitter.emitToken(fullContent);
        }
      }

      if (!fullContent.trim()) {
        throw new Error("Empty assistant reply after fallback");
      }

      const messageId = await this.deps.saveMessage("assistant", fullContent);
      await emitPhase("generating", "done");
      const ms = Date.now() - startTime;
      log.info({ messageId, ms }, "Interview start flow completed");
      await emitter.emitDone({ messageId, anchorsExtracted: 0 });
    } catch (error) {
      const ms = Date.now() - startTime;
      log.error({ err: error, ms }, "Interview start flow failed");
      await emitter.emitError(
        "LLM_ERROR",
        error instanceof Error ? error.message : "Unknown error",
      );
    }
  }

  async handleMessage(content: string, emitter: SSEEmitter): Promise<void> {
    const startTime = Date.now();
    const mode = getConversationFlowMode();
    const phaseEnabled = mode !== "off";
    const emitPhase = async (phase: ConversationPhase, label?: string): Promise<void> => {
      if (!phaseEnabled) return;
      await emitter.emitPhase({ phase, label });
    };

    let extractMs = 0;
    let recallMs = 0;
    let parallelWaitMs = 0;
    let detectMs = 0;

    log.info("Interview message flow initiated");

    try {
      const cleaned = await this.deps.cleanupEmptyAssistantMessages();
      if (cleaned > 0) {
        log.warn({ cleaned }, "Removed empty assistant replies before interview message handling");
      }

      await emitPhase("bootstrapping");
      // 保存用户消息
      await this.deps.saveMessage("user", content);
      const messages = await this.deps.getMessages(WINDOW_SIZE);
      const existingAnchors = await this.deps.getAnchors(200);

      const runExtract = async (): Promise<{ question: string; answer: string }[]> => {
        await emitPhase("extracting");
        const startedAt = Date.now();
        try {
          if (shouldInjectInterviewFailure("extract")) {
            throw new Error("Injected extract failure");
          }

          return await extractAnchors({
            chatClient: this.deps.chatClient,
            userMessage: content,
            recentMessages: messages.slice(-6).map((m) => ({ role: m.role, content: m.content })),
            existingAnchors,
          });
        } catch (error) {
          log.warn({ err: error }, "Anchor extraction failed, continuing with empty anchors");
          return [];
        } finally {
          extractMs = Date.now() - startedAt;
          await emitPhase("extracting", `${extractMs}`);
        }
      };

      const runRecall = async () => {
        await emitPhase("recalling");
        const startedAt = Date.now();
        try {
          return await goalBasedRecall({
            chatClient: this.deps.chatClient,
            embeddingClient: this.deps.embeddingClient,
            goals: [...INTERVIEW_RECALL_GOALS],
            searchAnchors: (emb) => this.deps.searchAnchors(emb),
            countAnchors: () => this.deps.getAnchorCount(),
            listAnchors: (limit?: number) => this.deps.getAnchors(limit ?? 200),
            buildJudgmentPrompt: ({ goals, anchors, context }) =>
              buildRecallJudgmentPrompt(anchors, context, goals) as ChatMessage[],
            parseJudgment: (value) => this.parseRecallJudgment(value),
            context: messages
              .map((m) => `${m.role}: ${m.content}`)
              .join("\n")
              .slice(-2000),
            onNarrative: (n) => emitter.emitThinking(n),
          });
        } finally {
          recallMs = Date.now() - startedAt;
          await emitPhase("recalling", `${recallMs}`);
        }
      };

      const runDetect = async (
        newAnchors: { question: string; answer: string }[],
        recalledAnchors: SoulAnchor[],
      ) => {
        await emitPhase("detecting");
        const startedAt = Date.now();
        try {
          if (shouldInjectInterviewFailure("detect")) {
            throw new Error("Injected detect failure");
          }

          return await detectContradictions({
            chatClient: this.deps.chatClient,
            newAnchors,
            existingAnchors: recalledAnchors,
          });
        } catch (error) {
          log.warn({ err: error }, "Contradiction detection failed, continuing with none");
          return [];
        } finally {
          detectMs = Date.now() - startedAt;
          await emitPhase("detecting", `${detectMs}`);
        }
      };

      let newAnchors: { question: string; answer: string }[] = [];
      let recalledAnchors: SoulAnchor[] = [];

      if (mode === "full") {
        const startedAt = Date.now();
        const [extractResult, recallResult] = await Promise.allSettled([runExtract(), runRecall()]);
        parallelWaitMs = Date.now() - startedAt;

        newAnchors = extractResult.status === "fulfilled" ? extractResult.value : [];
        if (extractResult.status === "rejected") {
          log.warn(
            { err: extractResult.reason },
            "Anchor extraction failed, continuing with empty anchors",
          );
        }

        if (recallResult.status === "rejected") {
          throw recallResult.reason;
        }

        recalledAnchors = recallResult.value.anchors;
      } else {
        newAnchors = await runExtract();
        const recall = await runRecall();
        recalledAnchors = recall.anchors;
      }

      if (newAnchors.length > 0) {
        await this.deps.saveAnchors(newAnchors);
        log.info({ count: newAnchors.length }, "New anchors saved from interview message");
      }

      // Step 3: 矛盾检测
      const contradictions = await runDetect(newAnchors, recalledAnchors);

      // Step 4: 生成回复
      await emitPhase("generating");
      const anchorCount = await this.deps.getAnchorCount();
      const systemPrompt = buildInterviewerSystemPrompt(
        recalledAnchors,
        contradictions,
        anchorCount,
      );
      const chatMessages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ];

      let fullContent = "";
      for await (const token of this.deps.chatClient.chatStream({ messages: chatMessages })) {
        fullContent += token;
        await emitter.emitToken(token);
      }

      if (!fullContent.trim()) {
        log.warn("Interview stream returned empty content, falling back to non-stream chat");
        fullContent = await this.chatFallback(chatMessages);
        if (fullContent) {
          await emitter.emitToken(fullContent);
        }
      }

      if (!fullContent.trim()) {
        throw new Error("Empty assistant reply after fallback");
      }

      const messageId = await this.deps.saveMessage("assistant", fullContent);
      await emitPhase("generating", "done");
      const ms = Date.now() - startTime;
      log.info(
        {
          messageId,
          anchorsExtracted: newAnchors.length,
          contradictions: contradictions.length,
          extractMs,
          recallMs,
          parallelWaitMs,
          detectMs,
          ms,
        },
        "Interview message flow completed",
      );
      await emitter.emitDone({ messageId, anchorsExtracted: newAnchors.length });
    } catch (error) {
      const ms = Date.now() - startTime;
      log.error({ err: error, ms }, "Interview message flow failed");
      await emitter.emitError(
        "LLM_ERROR",
        error instanceof Error ? error.message : "Unknown error",
      );
    }
  }
}
