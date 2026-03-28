import type { ChatClient, ChatMessage } from "../llm/client.js";
import type { EmbeddingClient } from "../embedding/client.js";
import type { SoulAnchor } from "../types.js";
import { goalBasedRecall } from "../recall/goal-based-recall.js";
import {
  buildReasoningDecompositionPrompt,
  buildReasoningGenerationPrompt,
  buildReasoningJudgmentPrompt,
  type ReasoningAnswerGoal,
} from "./prompts.js";
import { logger, shortKey } from "../logger.js";
import {
  REASONING_FULL_INJECTION_THRESHOLD,
  mapRecallRuntimeStrategyToReasoningStrategy,
  type ReasoningAnchorSelectionStrategy,
} from "./constants.js";

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

const DEFAULT_GOALS = [
  "我是谁，我的身份和表达风格",
  "对方是谁，我与对方的关系和沟通边界",
  "回答提问者的问题所需的认知",
];

const TEMPORAL_QUERY_PATTERN = /(最近|现在|目前|近期|变化|当前|latest|recent|current|now)/i;

type ParsedDecomposition = {
  userQuery: string;
  currentTime: string;
  answerGoals: ReasoningAnswerGoal[];
};

type ParsedJudgmentResult = {
  valid: boolean;
  judgment: {
    sufficient?: boolean;
    nextQuery?: string;
    narrative?: string;
    goalStatus?: {
      goalId?: unknown;
      sufficient?: unknown;
      known?: unknown;
      missing?: unknown;
      knownAnchorIds?: unknown;
      missingKeys?: unknown;
    }[];
  };
  reasoningChain?: string[];
};

function isValidGoalStatusEntry(entry: Record<string, unknown>): boolean {
  if (typeof entry.goalId !== "string" || !entry.goalId.trim()) {
    return false;
  }

  if (entry.sufficient !== undefined && typeof entry.sufficient !== "boolean") {
    return false;
  }

  for (const key of ["known", "missing", "knownAnchorIds", "missingKeys"] as const) {
    const value = entry[key];
    if (value !== undefined && !Array.isArray(value)) {
      return false;
    }
  }

  return true;
}

export class ReasoningEngine {
  constructor(private deps: ReasoningEngineDeps) {}

  private parseRecallJudgment(content: string): ParsedJudgmentResult {
    const parsed = JSON.parse(content) as {
      sufficient?: unknown;
      nextQuery?: unknown;
      narrative?: unknown;
      goalStatus?: unknown[];
      reasoningChain?: unknown;
    };

    const goalStatus = Array.isArray(parsed.goalStatus)
      ? parsed.goalStatus.filter(
          (item): item is Record<string, unknown> => !!item && typeof item === "object",
        )
      : undefined;
    const reasoningChain = Array.isArray(parsed.reasoningChain)
      ? parsed.reasoningChain.filter((item): item is string => typeof item === "string")
      : undefined;
    const valid =
      (parsed.sufficient === undefined || typeof parsed.sufficient === "boolean") &&
      (parsed.nextQuery === undefined || typeof parsed.nextQuery === "string") &&
      (parsed.narrative === undefined || typeof parsed.narrative === "string") &&
      (parsed.goalStatus === undefined ||
        (goalStatus !== undefined && goalStatus.every((entry) => isValidGoalStatusEntry(entry))));

    return {
      valid,
      judgment: {
        sufficient: typeof parsed.sufficient === "boolean" ? parsed.sufficient : undefined,
        nextQuery: typeof parsed.nextQuery === "string" ? parsed.nextQuery : undefined,
        narrative: typeof parsed.narrative === "string" ? parsed.narrative : undefined,
        goalStatus,
      },
      reasoningChain: valid ? reasoningChain : undefined,
    };
  }

  private isoNow(): string {
    return new Date().toISOString();
  }

  private buildDefaultAnswerGoals(content: string): ReasoningAnswerGoal[] {
    const goals: ReasoningAnswerGoal[] = [
      {
        id: "identity_style",
        goal: DEFAULT_GOALS[0],
        required: true,
      },
      {
        id: "relationship_boundary",
        goal: DEFAULT_GOALS[1],
        required: true,
      },
      {
        id: "domain_answer",
        goal: DEFAULT_GOALS[2],
        required: true,
      },
    ];

    if (TEMPORAL_QUERY_PATTERN.test(content)) {
      goals.push({
        id: "temporal_validity",
        goal: "判断回答依赖的信息是否受时间影响、是否可能过期",
        required: true,
      });
    }

    return goals;
  }

  private parseDecomposition(
    content: string,
    fallbackQuery: string,
    currentTime: string,
  ): ParsedDecomposition {
    const fallback: ParsedDecomposition = {
      userQuery: fallbackQuery,
      currentTime,
      answerGoals: this.buildDefaultAnswerGoals(fallbackQuery),
    };

    const parsed = JSON.parse(content) as {
      userQuery?: unknown;
      currentTime?: unknown;
      answerGoals?: unknown;
    };

    if (!Array.isArray(parsed.answerGoals)) {
      return fallback;
    }

    const answerGoals = parsed.answerGoals
      .filter((entry): entry is ReasoningAnswerGoal => {
        if (!entry || typeof entry !== "object") {
          return false;
        }

        const record = entry as Record<string, unknown>;
        return (
          typeof record.id === "string" &&
          record.id.trim().length > 0 &&
          typeof record.goal === "string" &&
          record.goal.trim().length > 0 &&
          typeof record.required === "boolean"
        );
      })
      .map((goal) => ({
        id: goal.id.trim(),
        goal: goal.goal.trim(),
        required: goal.required,
      }));

    if (answerGoals.length === 0) {
      return fallback;
    }

    const requiredGoalIds = new Set(
      answerGoals.filter((goal) => goal.required).map((goal) => goal.id),
    );
    const hasRequiredDefaults =
      requiredGoalIds.has("identity_style") &&
      requiredGoalIds.has("relationship_boundary") &&
      requiredGoalIds.has("domain_answer");

    if (!hasRequiredDefaults) {
      return fallback;
    }

    return {
      userQuery: fallback.userQuery,
      currentTime: fallback.currentTime,
      answerGoals,
    };
  }

  private collectMissingInformation(
    goalStatus: Array<{ sufficient: boolean; missing?: string[]; missingKeys?: string[] }>,
  ): string[] {
    const missing = goalStatus.flatMap((status) => {
      if (status.sufficient) {
        return [];
      }

      if (status.missing?.length) {
        return status.missing;
      }

      return status.missingKeys ?? [];
    });

    return Array.from(new Set(missing.filter(Boolean)));
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
        decomposition = this.parseDecomposition(
          decompositionResponse.content,
          content,
          currentTime,
        );
      } catch {
        decomposition = {
          userQuery: content,
          currentTime,
          answerGoals: this.buildDefaultAnswerGoals(content),
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
          const parsed = this.parseRecallJudgment(value);
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
      const missingInformation = this.collectMissingInformation(recall.goalStatus);
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
