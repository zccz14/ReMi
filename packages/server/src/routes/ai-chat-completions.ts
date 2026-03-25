import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { apiTokens } from "../db/schema.js";
import type { ConnectionManager } from "../db/connection.js";
import type { ChatClient } from "../llm/client.js";
import type { EmbeddingClient } from "../embedding/client.js";
import { AvatarInferenceRuntime } from "../avatar/runtime.js";
import { parseAvatarModel, type AvatarInferenceMessage } from "../avatar/model.js";

const openAiChatSchema = z.object({
  model: z.string().min(1),
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

export function aiChatCompletionsRoute(deps: {
  connMgr: ConnectionManager;
  chatClient: ChatClient | null;
  embeddingClient: EmbeddingClient | null;
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

    const supportedKeys = new Set(["model", "messages", "stream"]);
    const extraKey = Object.keys(rawBody).find((key) => !supportedKeys.has(key));
    if (extraKey) {
      return errorJson("unsupported_parameter", `Unsupported parameter: ${extraKey}`, 400);
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

    try {
      const runtime = new AvatarInferenceRuntime({
        ownerConn,
        chatClient: deps.chatClient,
        embeddingClient: deps.embeddingClient,
      });
      const request = await runtime.createRequest({
        avatarTarget: { publicKey: parsedModel.publicKey },
        conversationTurns: parsedBody.data.messages as AvatarInferenceMessage[],
        stream: parsedBody.data.stream,
      });

      if (!parsedBody.data.stream) {
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
        try {
          for await (const event of runtime.runStream(request)) {
            if (event.type === "message_start") {
              await stream.writeSSE({
                data: JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: parsedBody.data.model,
                  choices: [{ index: 0, delta: { role: event.message.role }, finish_reason: null }],
                }),
              });
              continue;
            }

            if (event.type === "text_delta") {
              await stream.writeSSE({
                data: JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: parsedBody.data.model,
                  choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }],
                }),
              });
              continue;
            }

            await stream.writeSSE({
              data: JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created,
                model: parsedBody.data.model,
                choices: [{ index: 0, delta: {}, finish_reason: event.finishReason }],
              }),
            });
          }

          await stream.writeSSE({ data: "[DONE]" });
        } catch (error) {
          await stream.writeSSE({
            data: JSON.stringify({
              error: {
                message: error instanceof Error ? error.message : "Unknown upstream error",
                type: "upstream_model_error",
                code: "upstream_model_error",
              },
            }),
          });
          await stream.writeSSE({ data: "[DONE]" });
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
