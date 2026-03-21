import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createEmbeddingClient } from "./embedding/client.js";
import { createChatClient } from "./llm/client.js";
import { logger } from "./logger.js";

const DATA_DIR = process.env.DATA_DIR ?? "./data";
const PORT = Number(process.env.PORT ?? 3000);
const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS ?? 1536);
const WEB_MODE = (process.env.WEB_MODE ?? "disabled") as "disabled" | "proxy";
const VITE_DEV_ORIGIN = process.env.VITE_DEV_ORIGIN ?? "http://localhost:5173";

const embeddingClient = process.env.EMBEDDING_API_KEY
  ? createEmbeddingClient({
      apiBase: process.env.EMBEDDING_API_BASE ?? "https://api.openai.com/v1",
      apiKey: process.env.EMBEDDING_API_KEY,
      model: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
    })
  : null;

const llmApiBase = process.env.LLM_API_BASE;
const llmApiKey = process.env.LLM_API_KEY;
const llmModel = process.env.LLM_MODEL;

const chatClient =
  llmApiBase && llmApiKey && llmModel
    ? createChatClient({ apiBase: llmApiBase, apiKey: llmApiKey, model: llmModel })
    : null;

const { app } = createApp({
  dataDir: DATA_DIR,
  embeddingDimensions: EMBEDDING_DIMENSIONS,
  embeddingClient,
  chatClient,
  web: {
    mode: WEB_MODE,
    viteOrigin: VITE_DEV_ORIGIN,
  },
});

logger.info(
  {
    dataDir: DATA_DIR,
    embeddingDimensions: EMBEDDING_DIMENSIONS,
    embeddingConfigured: !!embeddingClient,
    llmConfigured: !!chatClient,
    llmModel: llmModel ?? null,
    webMode: WEB_MODE,
    viteDevOrigin: VITE_DEV_ORIGIN,
  },
  "Starting ReMi server",
);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info({ port: info.port }, `ReMi server listening on http://localhost:${info.port}`);
});
