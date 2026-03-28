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
  buildDefaultAnswerGoals,
  collectMissingInformation,
  parseDecomposition,
  parseRecallJudgment,
  type ParsedDecomposition,
} from "../reasoning/orchestration.js";
import { goalBasedRecall } from "../recall/goal-based-recall.js";
import { RECALL_FULL_INJECTION_THRESHOLD } from "../recall/constants.js";
import { soulAnchors } from "../db/schema.js";
import type { ConnectionManager } from "../db/connection.js";
import type { SoulAnchor } from "../types.js";
import { readProfileSummary } from "../routes/profile.js";
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

interface AvatarInferenceRuntimeDeps {
  ownerConn: ReturnType<ConnectionManager["getConnection"]>;
  chatClient: ChatClient;
  embeddingClient: EmbeddingClient | null;
}

export class AvatarInferenceRuntime {
  constructor(private deps: AvatarInferenceRuntimeDeps) {}

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
    visitorKey?: string;
  }) {
    const anchorCount = await this.countAnchors();

    if (anchorCount <= RECALL_FULL_INJECTION_THRESHOLD || !this.deps.embeddingClient) {
      const anchors = await this.listAnchors();
      return await goalBasedRecall({
        chatClient: this.deps.chatClient,
        goals: input.answerGoals.filter((goal) => goal.required).map((goal) => goal.id),
        context: input.conversationTurns
          .map((turn) => `${turn.role}: ${turn.content}`)
          .join("\n")
          .slice(-2000),
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
      });
    }

    const context = input.conversationTurns
      .map((turn) => `${turn.role}: ${turn.content}`)
      .join("\n")
      .slice(-2000);
    let lastReasoningChain: string[] = [];

    const recall = await goalBasedRecall({
      chatClient: this.deps.chatClient,
      embeddingClient: this.deps.embeddingClient,
      goals: input.answerGoals.filter((goal) => goal.required).map((goal) => goal.id),
      context,
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
    });

    return { ...recall, reasoningChain: lastReasoningChain };
  }

  async createRequest(input: {
    avatarTarget: { publicKey: string };
    conversationTurns: AvatarInferenceMessage[];
    stream: boolean;
  }): Promise<AvatarInferenceRequest> {
    const profile = readProfileSummary(this.deps.ownerConn);
    const userQuery = findLatestUserQuery(input.conversationTurns);
    const currentTime = isoNow();

    let decomposition: ParsedDecomposition;
    try {
      const decompositionResponse = await this.deps.chatClient.chat({
        messages: buildReasoningDecompositionPrompt({
          currentTime,
          userQuery,
        }),
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
      visitorKey: undefined,
    });
    const missingInformation = collectMissingInformation(recall.goalStatus);

    return {
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
    const response = await this.deps.chatClient.chat({
      messages: this.buildMessages(request),
    });

    return {
      message: { role: "assistant", content: response.content },
      finishReason: response.finishReason,
      usage: response.usage,
    };
  }

  async *runStream(
    request: AvatarInferenceRequest,
  ): AsyncGenerator<AvatarInferenceEvent, void, unknown> {
    const upstream = this.deps.chatClient.chatStream({
      messages: this.buildMessages(request),
    });

    yield { type: "message_start", message: { role: "assistant" } };

    for await (const token of upstream) {
      yield { type: "text_delta", text: token };
    }

    yield { type: "message_end", finishReason: "stop" };
  }
}
