import { desc, inArray, sql } from "drizzle-orm";
import { searchSimilar } from "../embedding/index.js";
import type { EmbeddingClient } from "../embedding/client.js";
import type { ChatClient, ChatMessage } from "../llm/client.js";
import { buildBatchRecallJudgmentPrompt } from "../reasoning/prompts.js";
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

const DEFAULT_GOALS = [
  "我是谁，我的身份和表达风格",
  "回答当前请求所需的认知",
  "与调用方上下文一致的沟通边界",
];

function parseRecallJudgment(content: string): {
  sufficient: boolean;
  nextQuery?: string;
  narrative?: string;
} {
  const sufficient = content.includes("<sufficient>true</sufficient>");
  const nextQuery = content.match(/<next_query>([\s\S]*?)<\/next_query>/)?.[1]?.trim();
  const narrative = content.match(/<narrative>([\s\S]*?)<\/narrative>/)?.[1]?.trim();

  return {
    sufficient,
    nextQuery: nextQuery || undefined,
    narrative: narrative || undefined,
  };
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

  private async collectRecall(conversationTurns: AvatarInferenceMessage[]) {
    const anchorCount = await this.countAnchors();

    if (anchorCount <= RECALL_FULL_INJECTION_THRESHOLD || !this.deps.embeddingClient) {
      return await this.listAnchors();
    }

    const context = conversationTurns
      .map((turn) => `${turn.role}: ${turn.content}`)
      .join("\n")
      .slice(-2000);
    const recall = await goalBasedRecall({
      chatClient: this.deps.chatClient,
      embeddingClient: this.deps.embeddingClient,
      goals: DEFAULT_GOALS,
      context,
      countAnchors: () => this.countAnchors(),
      listAnchors: (limit?: number) => this.listAnchors(limit),
      searchAnchors: (embedding) => this.searchAnchors(embedding),
      buildJudgmentPrompt: ({ goals, anchors, context }) =>
        buildBatchRecallJudgmentPrompt(
          goals,
          anchors,
          context,
          conversationTurns.at(-1)?.content ?? "",
        ) as ChatMessage[],
      parseJudgment: (value) => parseRecallJudgment(value),
    });

    return recall.anchors;
  }

  async createRequest(input: {
    avatarTarget: { publicKey: string };
    conversationTurns: AvatarInferenceMessage[];
    stream: boolean;
  }): Promise<AvatarInferenceRequest> {
    const profile = readProfileSummary(this.deps.ownerConn);
    const recalledAnchors = await this.collectRecall(input.conversationTurns);

    return {
      avatarTarget: input.avatarTarget,
      instructionSegments: {
        platform: buildPlatformSegment(),
        avatar: buildAvatarIdentitySegment({
          publicKey: input.avatarTarget.publicKey,
          displayName: profile.displayName,
          bio: profile.bio,
        }),
        recall: buildRecallSegment(recalledAnchors),
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
    const firstToken = await upstream.next();

    yield { type: "message_start", message: { role: "assistant" } };

    if (!firstToken.done) {
      yield { type: "text_delta", text: firstToken.value };
    }

    for await (const token of upstream) {
      yield { type: "text_delta", text: token };
    }

    yield { type: "message_end", finishReason: "stop" };
  }
}
