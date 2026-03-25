import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { authMiddleware } from "./middleware/hono-auth.js";
import { determineRole } from "./middleware/role.js";
import { ConnectionManager } from "./db/connection.js";
import { type EmbeddingClient } from "./embedding/client.js";
import { healthRoutes } from "./routes/health.js";
import { anchorRoutes } from "./routes/anchors.js";
import { soulRoutes } from "./routes/soul.js";
import { profileRoutes } from "./routes/profile.js";
import { publicProfileRoutes } from "./routes/public-profile.js";
import { interviewRoutes } from "./routes/interview.js";
import { reasoningRoutes } from "./routes/reasoning.js";
import { conversationRoutes } from "./routes/conversations.js";
import { apiTokensRoutes } from "./routes/api-tokens.js";
import { aiChatCompletionsRoute } from "./routes/ai-chat-completions.js";
import { type ChatClient } from "./llm/client.js";
import { logger, shortKey } from "./logger.js";
import { proxyToVite, shouldProxyToVite, type WebConfig } from "./web/proxy.js";

interface AppConfig {
  dataDir: string;
  maxConnections?: number;
  embeddingDimensions?: number;
  embeddingClient?: EmbeddingClient | null;
  chatClient?: ChatClient | null;
  web?: WebConfig;
}

export function createApp(config: AppConfig) {
  const connMgr = new ConnectionManager(config.dataDir, {
    maxSize: config.maxConnections,
    embeddingDimensions: config.embeddingDimensions,
  });

  const app = new Hono();

  // CORS for frontend
  const corsOrigins = process.env.CORS_ORIGIN?.split(",").map((s) => s.trim()) ?? [];
  if (corsOrigins.length > 0) {
    const corsMiddleware = cors({
      origin: corsOrigins,
      allowHeaders: ["Content-Type", "X-Public-Key", "X-Timestamp", "X-Signature"],
      allowMethods: ["GET", "POST", "PUT", "DELETE"],
    });
    app.use("/api/*", corsMiddleware);
    app.use("/api", corsMiddleware);
  }

  // Request logging middleware
  app.use("/*", async (c: Context, next: Next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    const status = c.res.status;
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;

    const logData: Record<string, unknown> = { method, path, status, ms };

    const pubKey = c.req.param("pubKey");
    if (pubKey) {
      logData.soul = shortKey(pubKey);
    }

    const role = c.get("role") as string | undefined;
    if (role) {
      logData.role = role;
    }

    if (status >= 500) {
      logger.error(logData, `${method} ${path} ${status}`);
    } else if (status >= 400) {
      logger.warn(logData, `${method} ${path} ${status}`);
    } else {
      logger.info(logData, `${method} ${path} ${status}`);
    }
  });

  // Health check (no auth required)
  app.route("/api", healthRoutes);

  app.use("/api/public/*", async (c, next) => {
    c.set("connMgr", connMgr);
    await next();
  });
  app.route("/api", publicProfileRoutes);

  // Auth-required routes
  app.use("/api/:pubKey/*", authMiddleware());
  app.use("/api/:pubKey", authMiddleware());

  const embeddingClient = config.embeddingClient ?? null;
  const chatClient = config.chatClient ?? null;

  // Inject role + connMgr + embeddingClient + chatClient
  const injectContext = async (c: Context, next: Next) => {
    const signerPubKey = c.get("signerPubKey") as string;
    const targetPubKey = c.req.param("pubKey") as string;
    const role = determineRole(signerPubKey, targetPubKey);
    const soulExistedBeforeRequest = connMgr.soulExists(targetPubKey);
    const isCopyRequest = c.req.method === "POST" && new URL(c.req.url).pathname.endsWith("/copy");

    c.set("role", role);
    c.set("connMgr", connMgr);
    c.set("embeddingClient", embeddingClient);
    c.set("chatClient", chatClient);
    c.set("soulExistedBeforeRequest", soulExistedBeforeRequest);

    // Soul implicit creation
    if (role === "owner" && !soulExistedBeforeRequest && !isCopyRequest) {
      connMgr.getConnection(targetPubKey, { create: true });
      logger.info({ soul: shortKey(targetPubKey) }, "Soul implicitly created");
    } else if (role === "visitor" && !soulExistedBeforeRequest) {
      return c.json({ error: "SOUL_NOT_FOUND", message: "Soul does not exist" }, 404);
    }

    await next();
  };

  app.use("/api/:pubKey/*", injectContext);
  app.use("/api/:pubKey", injectContext);

  // Business routes
  app.route("/api", soulRoutes);
  app.route("/api", profileRoutes);
  app.route("/api", anchorRoutes);
  app.route("/api", interviewRoutes);
  app.route("/api", reasoningRoutes);
  app.route("/api", conversationRoutes);
  app.route("/api/:pubKey/api-tokens", apiTokensRoutes());
  app.route(
    "/ai/v1/chat/completions",
    aiChatCompletionsRoute({ connMgr, chatClient, embeddingClient }),
  );

  if (config.web?.mode === "proxy") {
    app.all("*", async (c) => {
      const url = new URL(c.req.url);
      if (!shouldProxyToVite(url.pathname)) {
        return c.notFound();
      }

      return proxyToVite(c.req.raw, config.web?.viteOrigin ?? "http://127.0.0.1:5173");
    });
  }

  return { app, connMgr };
}
