import { desc, inArray, sql } from "drizzle-orm";
import { searchSimilar } from "../embedding/index.js";
import type { EmbeddingClient } from "../embedding/client.js";
import type { ChatClient, ChatMessage } from "../llm/client.js";
import {
  buildReasoningDecompositionPrompt,
  buildReasoningJudgmentPrompt,
  type ReasoningAnswerGoal,
} from "../reasoning/prompts.js";
import {
  buildReasoningDebugArtifactSummary,
  type ReasoningDebugArtifactWriter,
  type ReasoningDebugTurn,
} from "../reasoning/debug-artifact.js";
import {
  buildDefaultAnswerGoals,
  collectMissingInformation,
  parseDecomposition,
  parseRecallJudgment,
  type ParsedDecomposition,
} from "../reasoning/orchestration.js";
import { goalBasedRecall } from "../recall/goal-based-recall.js";
import type { GoalStatus, RecallRoundSummary } from "../recall/goal-based-recall.js";
import { RECALL_FULL_INJECTION_THRESHOLD } from "../recall/constants.js";
import { soulAnchors } from "../db/schema.js";
import type { ConnectionManager } from "../db/connection.js";
import type { SoulAnchor } from "../types.js";
import { readProfileSummary } from "../routes/profile.js";
import { mapRecallRuntimeStrategyToReasoningStrategy } from "../reasoning/constants.js";
import {
  buildAvatarIdentitySegment,
  buildDownstreamMessages,
  buildPlatformSegment,
  buildRecallSegment,
} from "./message-augmentation.js";
import type {
  AvatarInferenceEvent,
  AvatarInferenceMessage,
  AvatarInferenceRequest,
  AvatarInferenceResponse,
} from "./model.js";

function findLatestUserQuery(conversationTurns: AvatarInferenceMessage[]): string {
  return (
    [...conversationTurns].reverse().find((turn) => turn.role === "user")?.content ??
    conversationTurns.at(-1)?.content ??
    ""
  );
}

function isoNow(): string {
  return new Date().toISOString();
}

function parseJsonIfPossible(content: string): unknown | undefined {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

type RuntimeDebugState = {
  currentTime: string;
  userQuery: string;
  requiredGoalIds: string[];
  finalAnchorIds: string[];
  anchorSelectionStrategy: string;
  rounds: number;
  stoppedBecause?: string;
  goalStatus: GoalStatus[];
  recallRounds: Array<
    Omit<RecallRoundSummary, "stoppedCandidate"> & { stoppedCandidate: string | null }
  >;
  turns: ReasoningDebugTurn[];
};

type PreparedInference = RuntimeDebugState & {
  request: AvatarInferenceRequest;
  thinkingNarratives: string[];
};

export type AvatarInferencePreparedMetadata = {
  thinkingNarratives: string[];
  recalledAnchorIds: string[];
  anchorSelectionStrategy: "full-injection" | "recall-loop";
};

interface AvatarInferenceRuntimeDeps {
  ownerConn: ReturnType<ConnectionManager["getConnection"]>;
  chatClient: ChatClient;
  embeddingClient: EmbeddingClient | null;
  debugArtifactWriter?: ReasoningDebugArtifactWriter;
}

export class AvatarInferenceRuntime {
  private preparedInferenceByRequest = new WeakMap<AvatarInferenceRequest, PreparedInference>();

  constructor(private deps: AvatarInferenceRuntimeDeps) {}

  private buildRuntimeTracePayload(
    request: AvatarInferenceRequest,
    messages: ChatMessage[],
    responseText: string,
  ) {
    const prepared = this.preparedInferenceByRequest.get(request);
    if (!prepared) {
      return null;
    }

    return {
      turns: [
        ...prepared.turns,
        {
          turnId: "03-final-generation",
          promptMessages: messages,
          responseText,
        },
      ],
      finalMessages: messages,
      recallRounds: prepared.recallRounds,
      response: responseText,
      summary: buildReasoningDebugArtifactSummary({
        currentTime: prepared.currentTime,
        userQuery: prepared.userQuery,
        rounds: prepared.rounds,
        stoppedBecause: prepared.stoppedBecause,
        finalAnchorIds: prepared.finalAnchorIds,
        goalStatus: prepared.goalStatus,
        requiredGoalIds: prepared.requiredGoalIds,
      }),
    };
  }

  private async writeRuntimeTraceBestEffort(
    request: AvatarInferenceRequest,
    messages: ChatMessage[],
    responseText: string,
  ): Promise<void> {
    if (!this.deps.debugArtifactWriter) {
      return;
    }

    const payload = this.buildRuntimeTracePayload(request, messages, responseText);
    if (!payload) {
      return;
    }

    try {
      await this.deps.debugArtifactWriter.writeLatestRuntimeTrace(payload);
    } catch {
      // Best-effort only: debug artifacts must not break successful inference paths.
    }
  }

  private async countAnchors(): Promise<number> {
    const row = this.deps.ownerConn.drizzle
      .select({ count: sql<number>`count(*)` })
      .from(soulAnchors)
      .get();
    return Number(row?.count ?? 0);
  }

  private async listAnchors(limit?: number): Promise<SoulAnchor[]> {
    const query = this.deps.ownerConn.drizzle
      .select()
      .from(soulAnchors)
      .orderBy(desc(soulAnchors.updatedAt), desc(soulAnchors.createdAt));

    return (limit === undefined ? query : query.limit(limit)).all() as SoulAnchor[];
  }

  private async searchAnchors(embedding: number[]): Promise<SoulAnchor[]> {
    const results = searchSimilar(this.deps.ownerConn.raw, "soul_anchors_vec", embedding, 10);
    if (results.length === 0) {
      return [];
    }

    const ids = results.map((result) => result.id);
    return this.deps.ownerConn.drizzle
      .select()
      .from(soulAnchors)
      .where(inArray(soulAnchors.id, ids))
      .all() as SoulAnchor[];
  }

  private async collectRecall(input: {
    conversationTurns: AvatarInferenceMessage[];
    currentTime: string;
    answerGoals: ReasoningAnswerGoal[];
    initialAnchors?: SoulAnchor[];
    visitorKey?: string;
    debugTurns?: ReasoningDebugTurn[];
    thinkingNarratives?: string[];
  }) {
    const sufficiencyTurns: Array<{ promptMessages: ChatMessage[]; responseText: string }> = [];
    const tracingChatClient: ChatClient = {
      chat: async (options) => {
        const response = await this.deps.chatClient.chat(options);
        sufficiencyTurns.push({ promptMessages: options.messages, responseText: response.content });
        return response;
      },
      chatStream: (options) => this.deps.chatClient.chatStream(options),
    };
    const anchorCount = await this.countAnchors();

    if (anchorCount <= RECALL_FULL_INJECTION_THRESHOLD || !this.deps.embeddingClient) {
      const anchors = await this.listAnchors();
      const recall = await goalBasedRecall({
        chatClient: tracingChatClient,
        goals: input.answerGoals.filter((goal) => goal.required).map((goal) => goal.id),
        context: input.conversationTurns
          .map((turn) => `${turn.role}: ${turn.content}`)
          .join("\n")
          .slice(-2000),
        initialAnchors: input.initialAnchors,
        countAnchors: () => this.countAnchors(),
        listAnchors: () => Promise.resolve(anchors),
        searchAnchors: async () => [],
        buildJudgmentPrompt: ({ anchors, context }) =>
          buildReasoningJudgmentPrompt({
            currentTime: input.currentTime,
            goals: input.answerGoals,
            anchors,
            visitorKey: input.visitorKey,
            visitorContext: context,
          }),
        parseJudgment: (value) => {
          const parsed = parseRecallJudgment(value);
          if (!parsed.valid) {
            throw new Error("Invalid reasoning judgment");
          }
          return parsed.judgment;
        },
        onNarrative: (narrative) => input.thinkingNarratives?.push(narrative),
      });
      input.debugTurns?.push(
        ...sufficiencyTurns.map((turn, index) => ({
          turnId: `02-sufficiency-round-${index + 1}`,
          promptMessages: turn.promptMessages,
          responseText: turn.responseText,
          responseJson: parseJsonIfPossible(turn.responseText),
        })),
      );
      return recall;
    }

    const context = input.conversationTurns
      .map((turn) => `${turn.role}: ${turn.content}`)
      .join("\n")
      .slice(-2000);
    let lastReasoningChain: string[] = [];

    const recall = await goalBasedRecall({
      chatClient: tracingChatClient,
      embeddingClient: this.deps.embeddingClient,
      goals: input.answerGoals.filter((goal) => goal.required).map((goal) => goal.id),
      context,
      initialAnchors: input.initialAnchors,
      countAnchors: () => this.countAnchors(),
      listAnchors: (limit?: number) => this.listAnchors(limit),
      searchAnchors: (embedding) => this.searchAnchors(embedding),
      buildJudgmentPrompt: ({ anchors, context }) =>
        buildReasoningJudgmentPrompt({
          currentTime: input.currentTime,
          goals: input.answerGoals,
          anchors,
          visitorKey: input.visitorKey,
          visitorContext: context,
        }),
      parseJudgment: (value) => {
        const parsed = parseRecallJudgment(value);
        if (!parsed.valid) {
          throw new Error("Invalid reasoning judgment");
        }
        if (parsed.reasoningChain?.length) {
          lastReasoningChain = parsed.reasoningChain;
        }
        return parsed.judgment;
      },
      onNarrative: (narrative) => input.thinkingNarratives?.push(narrative),
    });

    input.debugTurns?.push(
      ...sufficiencyTurns.map((turn, index) => ({
        turnId: `02-sufficiency-round-${index + 1}`,
        promptMessages: turn.promptMessages,
        responseText: turn.responseText,
        responseJson: parseJsonIfPossible(turn.responseText),
      })),
    );

    return { ...recall, reasoningChain: lastReasoningChain };
  }

  private async prepareInference(input: {
    avatarTarget: { publicKey: string };
    conversationTurns: AvatarInferenceMessage[];
    initialAnchors?: SoulAnchor[];
    stream: boolean;
    visitorKey?: string;
  }): Promise<PreparedInference> {
    const profile = readProfileSummary(this.deps.ownerConn);
    const userQuery = findLatestUserQuery(input.conversationTurns);
    const currentTime = isoNow();
    const debugTurns: ReasoningDebugTurn[] = [];
    const thinkingNarratives: string[] = [];

    let decomposition: ParsedDecomposition;
    try {
      const decompositionPrompt = buildReasoningDecompositionPrompt({
        currentTime,
        userQuery,
      });
      const decompositionResponse = await this.deps.chatClient.chat({
        messages: decompositionPrompt,
      });
      debugTurns.push({
        turnId: "01-decomposition",
        promptMessages: decompositionPrompt,
        responseText: decompositionResponse.content,
        responseJson: parseJsonIfPossible(decompositionResponse.content),
      });
      decomposition = parseDecomposition(decompositionResponse.content, userQuery, currentTime);
    } catch {
      decomposition = {
        userQuery,
        currentTime,
        answerGoals: buildDefaultAnswerGoals(userQuery),
      };
    }

    const recall = await this.collectRecall({
      conversationTurns: input.conversationTurns,
      currentTime,
      answerGoals: decomposition.answerGoals,
      initialAnchors: input.initialAnchors,
      visitorKey: input.visitorKey,
      debugTurns,
      thinkingNarratives,
    });
    const missingInformation = collectMissingInformation(recall.goalStatus);

    const request: AvatarInferenceRequest = {
      avatarTarget: input.avatarTarget,
      instructionSegments: {
        platform: buildPlatformSegment(),
        avatar: buildAvatarIdentitySegment({
          publicKey: input.avatarTarget.publicKey,
          displayName: profile.displayName,
          bio: profile.bio,
        }),
        recall: buildRecallSegment({
          anchors: recall.anchors,
          missingInformation,
          stoppedBecause: recall.stoppedBecause,
          goalStatus: recall.goalStatus,
        }),
      },
      conversationTurns: input.conversationTurns,
      contentParts: [],
      stream: input.stream,
    };

    return {
      request,
      currentTime,
      userQuery: decomposition.userQuery,
      requiredGoalIds: decomposition.answerGoals
        .filter((goal) => goal.required)
        .map((goal) => goal.id),
      rounds: recall.rounds,
      stoppedBecause: recall.stoppedBecause,
      finalAnchorIds: recall.anchors.map((anchor) => anchor.id),
      anchorSelectionStrategy: recall.strategy,
      goalStatus: recall.goalStatus,
      recallRounds: recall.roundSummaries.map((roundSummary) => ({
        round: roundSummary.round,
        query: roundSummary.query,
        newAnchorIds: roundSummary.newAnchorIds,
        allAnchorIds: roundSummary.allAnchorIds,
        normalizedGoalStatus: roundSummary.normalizedGoalStatus,
        stoppedCandidate: roundSummary.stoppedCandidate ?? null,
      })),
      turns: debugTurns,
      thinkingNarratives,
    };
  }

  async createRequest(input: {
    avatarTarget: { publicKey: string };
    conversationTurns: AvatarInferenceMessage[];
    initialAnchors?: SoulAnchor[];
    stream: boolean;
    visitorKey?: string;
  }): Promise<AvatarInferenceRequest> {
    const prepared = await this.prepareInference(input);
    this.preparedInferenceByRequest.set(prepared.request, prepared);
    return prepared.request;
  }

  getPreparedMetadata(
    request: AvatarInferenceRequest,
  ): AvatarInferencePreparedMetadata | undefined {
    const prepared = this.preparedInferenceByRequest.get(request);
    if (!prepared) {
      return undefined;
    }

    return {
      thinkingNarratives: [...prepared.thinkingNarratives],
      recalledAnchorIds: [...prepared.finalAnchorIds],
      anchorSelectionStrategy: prepared.anchorSelectionStrategy as "full-injection" | "recall-loop",
    };
  }

  getPreparedReasoningMetadata(request: AvatarInferenceRequest):
    | {
        thinkingNarratives: string[];
        recalledAnchorIds: string[];
        anchorSelectionStrategy: "full-injection" | "batch-recall";
      }
    | undefined {
    const metadata = this.getPreparedMetadata(request);
    if (!metadata) {
      return undefined;
    }
    return {
      thinkingNarratives: metadata.thinkingNarratives,
      recalledAnchorIds: metadata.recalledAnchorIds,
      anchorSelectionStrategy: mapRecallRuntimeStrategyToReasoningStrategy(
        metadata.anchorSelectionStrategy,
      ),
    };
  }

  buildMessages(request: AvatarInferenceRequest): ChatMessage[] {
    return buildDownstreamMessages({
      platform: request.instructionSegments.platform,
      avatar: request.instructionSegments.avatar,
      callerMessages: request.conversationTurns,
      recall: request.instructionSegments.recall,
    });
  }

  async run(request: AvatarInferenceRequest): Promise<AvatarInferenceResponse> {
    try {
      const messages = this.buildMessages(request);
      const response = await this.deps.chatClient.chat({ messages });
      await this.writeRuntimeTraceBestEffort(request, messages, response.content);

      return {
        message: { role: "assistant", content: response.content },
        finishReason: response.finishReason,
        usage: response.usage,
      };
    } finally {
      this.preparedInferenceByRequest.delete(request);
    }
  }

  async *runStream(
    request: AvatarInferenceRequest,
  ): AsyncGenerator<AvatarInferenceEvent, void, unknown> {
    try {
      const messages = this.buildMessages(request);
      const upstream = this.deps.chatClient.chatStream({ messages });
      let fullContent = "";

      yield { type: "message_start", message: { role: "assistant" } };

      for await (const token of upstream) {
        fullContent += token;
        yield { type: "text_delta", text: token };
      }

      await this.writeRuntimeTraceBestEffort(request, messages, fullContent);

      yield { type: "message_end", finishReason: "stop" };
    } finally {
      this.preparedInferenceByRequest.delete(request);
    }
  }
}
