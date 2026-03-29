import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { createApprovalService } from "../approval/service.js";
import { apiTokens } from "../db/schema.js";
import type { ConnectionManager } from "../db/connection.js";
import type { ChatClient } from "../llm/client.js";
import type { EmbeddingClient } from "../embedding/client.js";
import { AvatarInferenceRuntime } from "../avatar/runtime.js";
import { parseAvatarModel, type AvatarInferenceMessage } from "../avatar/model.js";
import { createSseHeartbeat } from "../lib/sse-heartbeat.js";
import { isAbortError, throwIfAborted } from "../lib/abort.js";
import type { PendingReasoningProbe } from "../reasoning/gap-probes.js";

const openAiChatSchema = z.object({
  model: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
    }),
  ),
  stream: z.boolean().optional().default(false),
});

function errorJson(code: string, message: string, status: number) {
  return Response.json(
    {
      error: {
        message,
        type: code,
        code,
      },
    },
    { status },
  );
}

function readBearerToken(authorization: string | undefined) {
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice(7).trim();
  return token || null;
}

function createCompletionId() {
  return `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
}

function buildStreamChunk(params: {
  id: string;
  created: number;
  model: string;
  delta: Record<string, unknown>;
  finishReason: string | null;
}) {
  return JSON.stringify({
    id: params.id,
    object: "chat.completion.chunk",
    created: params.created,
    model: params.model,
    choices: [{ index: 0, delta: params.delta, finish_reason: params.finishReason }],
  });
}

function buildChunkData(params: {
  id: string;
  created: number;
  model: string;
  event:
    | {
        type: "message_start";
        message: { role: string };
      }
    | {
        type: "text_delta";
        text: string;
      }
    | {
        type: "message_end";
        finishReason: string;
      };
}) {
  if (params.event.type === "message_start") {
    return buildStreamChunk({
      id: params.id,
      created: params.created,
      model: params.model,
      delta: { role: params.event.message.role },
      finishReason: null,
    });
  }

  if (params.event.type === "text_delta") {
    return buildStreamChunk({
      id: params.id,
      created: params.created,
      model: params.model,
      delta: { content: params.event.text },
      finishReason: null,
    });
  }

  return buildStreamChunk({
    id: params.id,
    created: params.created,
    model: params.model,
    delta: {},
    finishReason: params.event.finishReason,
  });
}

export function aiChatCompletionsRoute(deps: {
  connMgr: ConnectionManager;
  chatClient: ChatClient | null;
  embeddingClient: EmbeddingClient | null;
  sseHeartbeatTiming?: {
    silentMs?: number;
    intervalMs?: number;
  } | null;
}) {
  const routes = new Hono();

  routes.post("/", async (c) => {
    if (!deps.chatClient) {
      return errorJson("upstream_model_error", "Chat client not configured", 502);
    }

    const rawBody = await c.req.json().catch(() => null);
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      return errorJson("invalid_request", "Request body must be a JSON object", 400);
    }

    const rawModel = rawBody.model;
    if (typeof rawModel !== "string" || rawModel.trim().length === 0) {
      return errorJson("invalid_model", "Model must be ReMi-<pubKey>", 400);
    }

    const parsedBody = openAiChatSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return errorJson("invalid_request", parsedBody.error.message, 400);
    }

    const parsedModel = parseAvatarModel(parsedBody.data.model);
    if (!parsedModel) {
      return errorJson("invalid_model", "Model must be ReMi-<pubKey>", 400);
    }

    if (!deps.connMgr.soulExists(parsedModel.publicKey)) {
      return errorJson("model_not_found", "Target avatar does not exist", 404);
    }

    const ownerConn = deps.connMgr.getConnection(parsedModel.publicKey);
    const token = readBearerToken(c.req.header("Authorization"));
    if (!token) {
      return errorJson("invalid_api_key", "Invalid API key", 401);
    }

    const tokenRow = ownerConn.drizzle
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(eq(apiTokens.id, token))
      .get();
    if (!tokenRow) {
      return errorJson("invalid_api_key", "Invalid API key", 401);
    }

    const id = createCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const approvalService = createApprovalService({
      ownerKey: parsedModel.publicKey,
      conn: ownerConn,
      embeddingClient: deps.embeddingClient,
    });
    const flushReasoningProbes = async (probes: PendingReasoningProbe[]) => {
      for (const probe of probes) {
        approvalService.createCandidate({
          question: probe.displayQuestion,
          answer: null,
          source: "reasoning",
          sourceRef: probe.sourceRef,
          sourceSnapshot: probe.sourceSnapshot,
        });
      }
    };
    const runtime = new AvatarInferenceRuntime({
      ownerConn,
      chatClient: deps.chatClient,
      embeddingClient: deps.embeddingClient,
      flushReasoningProbes,
    });

    try {
      if (!parsedBody.data.stream) {
        const request = await runtime.createRequest({
          avatarTarget: { publicKey: parsedModel.publicKey },
          conversationTurns: parsedBody.data.messages as AvatarInferenceMessage[],
          stream: parsedBody.data.stream,
        });
        const response = await runtime.run(request);
        return c.json({
          id,
          object: "chat.completion",
          created,
          model: parsedBody.data.model,
          choices: [
            {
              index: 0,
              message: response.message,
              finish_reason: response.finishReason,
            },
          ],
          usage: {
            prompt_tokens: response.usage.promptTokens,
            completion_tokens: response.usage.completionTokens,
            total_tokens: response.usage.totalTokens,
          },
        });
      }

      return streamSSE(c, async (stream) => {
        let transportFailure: unknown = null;
        const abortController = new AbortController();

        function markTransportFailure(error: unknown) {
          if (transportFailure === null) {
            transportFailure = error;
            abortController.abort(error);
          }
          return transportFailure;
        }

        function isTransportFailure(error: unknown) {
          return (
            transportFailure !== null &&
            (error === transportFailure ||
              error === abortController.signal.reason ||
              isAbortError(error))
          );
        }

        function ensureStreamHealthy() {
          if (transportFailure !== null) {
            throw transportFailure;
          }
          throwIfAborted(abortController.signal);
        }

        const heartbeat = createSseHeartbeat({
          writeComment: async (frame) => {
            await stream.write(frame);
          },
          onError: (error) => {
            markTransportFailure(error);
          },
          silentMs: deps.sseHeartbeatTiming?.silentMs,
          intervalMs: deps.sseHeartbeatTiming?.intervalMs,
        });

        async function writeOpenAiChunk(data: string) {
          ensureStreamHealthy();
          try {
            await stream.writeSSE({ data });
          } catch (error) {
            throw markTransportFailure(error);
          }
          heartbeat.recordRealWrite();
        }

        try {
          await writeOpenAiChunk(
            buildChunkData({
              id,
              created,
              model: parsedBody.data.model,
              event: { type: "message_start", message: { role: "assistant" } },
            }),
          );

          heartbeat.start();

          await Promise.race([
            (async () => {
              const request = await runtime.createRequest({
                avatarTarget: { publicKey: parsedModel.publicKey },
                conversationTurns: parsedBody.data.messages as AvatarInferenceMessage[],
                stream: parsedBody.data.stream,
                signal: abortController.signal,
              });
              ensureStreamHealthy();

              for await (const event of runtime.runStream(request)) {
                if (event.type === "message_start") {
                  continue;
                }
                await writeOpenAiChunk(
                  buildChunkData({
                    id,
                    created,
                    model: parsedBody.data.model,
                    event,
                  }),
                );
              }

              await writeOpenAiChunk("[DONE]");
            })(),
            heartbeat.failure,
          ]);
        } catch (error) {
          if (isTransportFailure(error)) {
            return;
          }

          try {
            await writeOpenAiChunk(
              JSON.stringify({
                error: {
                  message: error instanceof Error ? error.message : "Unknown upstream error",
                  type: "upstream_model_error",
                  code: "upstream_model_error",
                },
              }),
            );
            await writeOpenAiChunk("[DONE]");
          } catch (writeFailure) {
            if (isTransportFailure(writeFailure)) {
              return;
            }
            throw writeFailure;
          }
        } finally {
          heartbeat.stop();
        }
      });
    } catch (error) {
      return errorJson(
        "upstream_model_error",
        error instanceof Error ? error.message : "Unknown upstream error",
        502,
      );
    }
  });

  return routes;
}
