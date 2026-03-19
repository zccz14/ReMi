import type { ChatClient, ChatMessage } from "../llm/client.js";
import type { EmbeddingClient } from "../embedding/client.js";
import type { SoulAnchor } from "../types.js";
import { extractAnchors } from "./extractor.js";
import { agenticRecall } from "./recall.js";
import { detectContradictions } from "./contradiction.js";
import { buildInterviewerSystemPrompt } from "./prompts.js";

export interface SSEEmitter {
  emitThinking(narrative: string): void;
  emitToken(content: string): void;
  emitDone(data: { messageId: number; anchorsExtracted: number }): void;
  emitError(code: string, message: string): void;
}

export interface EngineDeps {
  chatClient: ChatClient;
  embeddingClient: EmbeddingClient;
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

export class InterviewEngine {
  constructor(private deps: EngineDeps) {}

  async start(emitter: SSEEmitter): Promise<void> {
    try {
      const messages = await this.deps.getMessages(WINDOW_SIZE);
      const anchorCount = await this.deps.getAnchorCount();

      // Agentic Recall
      const recall = await agenticRecall({
        chatClient: this.deps.chatClient,
        embeddingClient: this.deps.embeddingClient,
        searchAnchors: (emb) => this.deps.searchAnchors(emb),
        context:
          messages
            .map((m) => `${m.role}: ${m.content}`)
            .join("\n")
            .slice(-2000) || "新用户，第一次对话",
        goal: "理解本体已有的认知框架，准备发起/恢复访谈",
        onNarrative: (n) => emitter.emitThinking(n),
      });

      // 生成回复
      const systemPrompt = buildInterviewerSystemPrompt(recall.anchors, [], anchorCount);
      const chatMessages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ];

      if (messages.length === 0) {
        chatMessages.push({
          role: "system",
          content: "这是第一次对话，请用冷启动协议开场：声明边界，给选择权，用轻量级问题。",
        });
      } else {
        chatMessages.push({
          role: "system",
          content: "用户回来继续对话，生成一条恢复衔接消息。",
        });
      }

      let fullContent = "";
      for await (const token of this.deps.chatClient.chatStream({ messages: chatMessages })) {
        fullContent += token;
        emitter.emitToken(token);
      }

      const messageId = await this.deps.saveMessage("assistant", fullContent);
      emitter.emitDone({ messageId, anchorsExtracted: 0 });
    } catch (error) {
      emitter.emitError("LLM_ERROR", error instanceof Error ? error.message : "Unknown error");
    }
  }

  async handleMessage(content: string, emitter: SSEEmitter): Promise<void> {
    try {
      // 保存用户消息
      await this.deps.saveMessage("user", content);
      const messages = await this.deps.getMessages(WINDOW_SIZE);
      const existingAnchors = await this.deps.getAnchors(200);

      // Step 1: 锚点提取
      const newAnchors = await extractAnchors({
        chatClient: this.deps.chatClient,
        userMessage: content,
        recentMessages: messages.slice(-6).map((m) => ({ role: m.role, content: m.content })),
        existingAnchors,
      });

      if (newAnchors.length > 0) {
        await this.deps.saveAnchors(newAnchors);
      }

      // Step 2: Agentic Recall
      const recall = await agenticRecall({
        chatClient: this.deps.chatClient,
        embeddingClient: this.deps.embeddingClient,
        searchAnchors: (emb) => this.deps.searchAnchors(emb),
        context: messages
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n")
          .slice(-2000),
        goal: "充分理解本体在当前话题的认知，问出好问题",
        onNarrative: (n) => emitter.emitThinking(n),
      });

      // Step 3: 矛盾检测
      const contradictions = await detectContradictions({
        chatClient: this.deps.chatClient,
        newAnchors,
        existingAnchors: recall.anchors,
      });

      // Step 4: 生成回复
      const anchorCount = await this.deps.getAnchorCount();
      const systemPrompt = buildInterviewerSystemPrompt(
        recall.anchors,
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
        emitter.emitToken(token);
      }

      const messageId = await this.deps.saveMessage("assistant", fullContent);
      emitter.emitDone({ messageId, anchorsExtracted: newAnchors.length });
    } catch (error) {
      emitter.emitError("LLM_ERROR", error instanceof Error ? error.message : "Unknown error");
    }
  }
}
