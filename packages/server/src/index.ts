import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createEmbeddingClient } from "./embedding/client.js";
import { createExecutionClient } from "./goals/execution-client.js";
import { buildDefaultSchedulerDecision, createGoalScheduler } from "./goals/scheduler.js";
import {
  createPlatformRunner,
  listEligibleUsersFromDataDir,
  parsePlatformRunnerConfig,
} from "./goals/platform-runner.js";
import { createGoalsService } from "./goals/service.js";
import { createChatClient } from "./llm/client.js";
import { logger } from "./logger.js";

const DATA_DIR = process.env.DATA_DIR ?? "./data";
const PORT = Number(process.env.PORT ?? 3000);
const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS ?? 1536);
const WEB_MODE = (process.env.WEB_MODE ?? "disabled") as "disabled" | "proxy" | "static";
const WEB_DIST_DIR = process.env.WEB_DIST_DIR;
const VITE_DEV_ORIGIN = process.env.VITE_DEV_ORIGIN ?? "http://localhost:5173";
const EXECUTION_ROOT_SEED = process.env.EXECUTION_ROOT_SEED;

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

const { app, connMgr } = createApp({
  dataDir: DATA_DIR,
  embeddingDimensions: EMBEDDING_DIMENSIONS,
  embeddingClient,
  chatClient,
  web: {
    mode: WEB_MODE,
    distDir: WEB_DIST_DIR,
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
    webDistDir: WEB_DIST_DIR ?? null,
    viteDevOrigin: VITE_DEV_ORIGIN,
  },
  "Starting ReMi server",
);

const platformRunnerConfig = parsePlatformRunnerConfig(process.env);

if (platformRunnerConfig.enabled) {
  if (!EXECUTION_ROOT_SEED) {
    logger.warn("Platform scheduler enabled without EXECUTION_ROOT_SEED; runner not started");
  } else {
    const platformRunner = createPlatformRunner({
      config: platformRunnerConfig,
      listEligibleUsers: () => listEligibleUsersFromDataDir(DATA_DIR),
      async activateUser(pubKey) {
        const conn = connMgr.getConnection(pubKey);
        const service = createGoalsService(conn);
        const scheduler = createGoalScheduler({
          userIdentityPubkey: pubKey,
          service,
          chooser: {
            chooseChild(candidates) {
              return candidates[0]?.id ?? null;
            },
          },
          executionClientFactory: {
            getClient(baseUrl) {
              return createExecutionClient({
                baseUrl,
                rootSeed: EXECUTION_ROOT_SEED,
                userIdentityPubkey: pubKey,
              });
            },
          },
          decideActivation({ nodes, selection }) {
            return buildDefaultSchedulerDecision({ nodes, selection });
          },
        });

        await scheduler.runCycle();
      },
      onError(error) {
        logger.error({ error }, "Platform scheduler tick failed");
      },
    });

    platformRunner.start();
    logger.info(platformRunnerConfig, "Platform scheduler started");
  }
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info({ port: info.port }, `ReMi server listening on http://localhost:${info.port}`);
});
