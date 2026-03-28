import type { ChatClient, ChatMessage } from "../llm/client.js";
import type { EmbeddingClient } from "../embedding/client.js";
import type { SoulAnchor } from "../types.js";
import { goalBasedRecall } from "../recall/goal-based-recall.js";
import {
  buildReasoningDecompositionPrompt,
  buildReasoningGenerationPrompt,
  buildReasoningJudgmentPrompt,
} from "./prompts.js";
import {
  buildDefaultAnswerGoals,
  collectMissingInformation,
  parseDecomposition,
  parseRecallJudgment,
  type ParsedDecomposition,
} from "./orchestration.js";
import { logger, shortKey } from "../logger.js";
import {
  REASONING_FULL_INJECTION_THRESHOLD,
  mapRecallRuntimeStrategyToReasoningStrategy,
  type ReasoningAnchorSelectionStrategy,
} from "./constants.js";
import {
  buildReasoningDebugArtifactSummary,
  type ReasoningDebugArtifactWriter,
} from "./debug-artifact.js";

const log = logger.child({ module: "reasoning" });

export interface ReasoningSSEEmitter {
  emitThinking(narrative: string): void | Promise<void>;
  emitToken(content: string): void | Promise<void>;
  emitDone(data: {
    messageId: number;
    recalledAnchors: string[];
    shared_message_id?: string;
    content?: string;
  }): void | Promise<void>;
  emitError(code: string, message: string): void | Promise<void>;
}

export interface ReasoningEngineDeps {
  chatClient: ChatClient;
  embeddingClient?: EmbeddingClient;
  debugArtifactWriter?: ReasoningDebugArtifactWriter;
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
  ): Promise<{ messageId: number; sharedMessageId: string }>;
  searchAnchors(embedding: number[]): Promise<SoulAnchor[]>;
  getCachedAnchorIds(visitorKey: string): Promise<string[]>;
  getAnchorsByIds(ids: string[]): Promise<SoulAnchor[]>;
}

const WINDOW_SIZE = 20;

export class ReasoningEngine {
  constructor(private deps: ReasoningEngineDeps) {}

  private isoNow(): string {
    return new Date().toISOString();
  }

  async handleMessage(
    content: string,
    visitorKey: string,
    emitter: ReasoningSSEEmitter,
    options?: { skipUserPersist?: boolean },
  ): Promise<void> {
    const startTime = Date.now();
    log.info({ visitor: shortKey(visitorKey) }, "Reasoning message flow initiated");

    try {
      if (!options?.skipUserPersist) {
        await this.deps.saveMessage(visitorKey, "user", content);
      }
      const messages = await this.deps.getMessages(visitorKey, WINDOW_SIZE);
      const anchorCount = await this.deps.countAnchors();
      const currentTime = this.isoNow();
      log.debug({ messageCount: messages.length, anchorCount }, "Reasoning context loaded");

      const contextStr = messages
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n")
        .slice(-2000);

      const decompositionResponse = await this.deps.chatClient.chat({
        messages: buildReasoningDecompositionPrompt({
          currentTime,
          userQuery: content,
        }),
      });

      let decomposition: ParsedDecomposition;
      try {
        decomposition = parseDecomposition(decompositionResponse.content, content, currentTime);
      } catch {
        decomposition = {
          userQuery: content,
          currentTime,
          answerGoals: buildDefaultAnswerGoals(content),
        };
      }

      const requiredGoalIds = decomposition.answerGoals
        .filter((goal) => goal.required)
        .map((goal) => goal.id);

      let lastReasoningChain: string[] = [];

      const cachedAnchors =
        anchorCount > REASONING_FULL_INJECTION_THRESHOLD
          ? (() => this.deps.getCachedAnchorIds(visitorKey))().then((cachedIds) =>
              cachedIds.length > 0 ? this.deps.getAnchorsByIds(cachedIds) : Promise.resolve([]),
            )
          : Promise.resolve([] as SoulAnchor[]);
      const recall = await goalBasedRecall({
        chatClient: this.deps.chatClient,
        embeddingClient: this.deps.embeddingClient,
        goals: requiredGoalIds,
        context: contextStr,
        initialAnchors: await cachedAnchors,
        countAnchors: () => this.deps.countAnchors(),
        listAnchors: (limit?: number) => this.deps.listAnchors(limit),
        searchAnchors: (emb) => this.deps.searchAnchors(emb),
        buildJudgmentPrompt: ({ anchors, context }) =>
          buildReasoningJudgmentPrompt({
            currentTime,
            goals: decomposition.answerGoals,
            anchors,
            visitorKey,
            visitorContext: context,
          }),
        parseJudgment: (value) => {
          const parsed = parseRecallJudgment(value);
          if (!parsed.valid) {
            throw new Error("Invalid reasoning judgment");
          }
          if (parsed.valid && parsed.reasoningChain?.length) {
            lastReasoningChain = parsed.reasoningChain;
          }
          return parsed.judgment;
        },
        onNarrative: (n) => emitter.emitThinking(n),
      });

      const selectedAnchors = recall.anchors;
      const anchorSelectionStrategy = mapRecallRuntimeStrategyToReasoningStrategy(recall.strategy);
      const missingInformation = collectMissingInformation(recall.goalStatus);
      const systemPrompt = buildReasoningGenerationPrompt({
        currentTime,
        userQuestion: decomposition.userQuery,
        answerGoals: decomposition.answerGoals,
        evidenceAnchors: selectedAnchors,
        goalStatus: recall.goalStatus,
        missingInformation,
        stoppedBecause: recall.stoppedBecause,
        reasoningChain: lastReasoningChain,
        temporalValiditySatisfied: !requiredGoalIds.includes("temporal_validity")
          ? undefined
          : recall.goalStatus.find((status) => status.goalId === "temporal_validity")?.sufficient,
      });

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
      const savedAssistant = await this.deps.saveMessage(
        visitorKey,
        "assistant",
        fullContent,
        anchorIds,
        anchorSelectionStrategy,
      );

      if (this.deps.debugArtifactWriter) {
        try {
          await this.deps.debugArtifactWriter.writeLatest({
            request: {
              visitorKey,
              userQuery: content,
              currentTime,
              messageCount: messages.length,
              context: contextStr,
            },
            decomposition: {
              userQuery: decomposition.userQuery,
              currentTime: decomposition.currentTime,
              answerGoals: decomposition.answerGoals,
            },
            recallRounds: recall.roundSummaries.map((roundSummary) => ({
              round: roundSummary.round,
              query: roundSummary.query,
              newAnchorIds: roundSummary.newAnchorIds,
              allAnchorIds: roundSummary.allAnchorIds,
              normalizedGoalStatus: roundSummary.normalizedGoalStatus,
              stoppedCandidate: roundSummary.stoppedCandidate ?? null,
            })),
            finalPrompt: systemPrompt,
            response: fullContent,
            summary: buildReasoningDebugArtifactSummary({
              currentTime,
              userQuery: decomposition.userQuery,
              rounds: recall.rounds,
              stoppedBecause: recall.stoppedBecause,
              finalAnchorIds: anchorIds,
              goalStatus: recall.goalStatus,
              requiredGoalIds,
            }),
          });
        } catch (error) {
          log.warn({ err: error }, "Failed to write reasoning debug artifact");
        }
      }

      const ms = Date.now() - startTime;
      log.info(
        {
          messageId: savedAssistant.messageId,
          recalledAnchors: anchorIds.length,
          selectionStrategy: anchorSelectionStrategy,
          anchorCount,
          rounds: recall.rounds,
          stoppedBecause: recall.stoppedBecause,
          goalCount: decomposition.answerGoals.length,
          promptChars: systemPrompt.length,
          ms,
        },
        "Reasoning message flow completed",
      );

      await emitter.emitDone({
        messageId: savedAssistant.messageId,
        shared_message_id: savedAssistant.sharedMessageId,
        content: fullContent,
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
