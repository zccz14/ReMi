import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { authMiddleware } from "./middleware/hono-auth.js";
import { determineRole } from "./middleware/role.js";
import { ConnectionManager } from "./db/connection.js";
import { type EmbeddingClient } from "./embedding/client.js";
import { healthRoutes } from "./routes/health.js";
import { anchorRoutes } from "./routes/anchors.js";
import { soulRoutes } from "./routes/soul.js";
import { interviewRoutes } from "./routes/interview.js";
import { reasoningRoutes } from "./routes/reasoning.js";
import { conversationRoutes } from "./routes/conversations.js";
import { type ChatClient } from "./llm/client.js";
import { logger, shortKey } from "./logger.js";

interface AppConfig {
  dataDir: string;
  maxConnections?: number;
  embeddingDimensions?: number;
  embeddingClient?: EmbeddingClient | null;
  chatClient?: ChatClient | null;
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
    app.use(
      "/*",
      cors({
        origin: corsOrigins,
        allowHeaders: ["Content-Type", "X-Public-Key", "X-Timestamp", "X-Signature"],
        allowMethods: ["GET", "POST", "PUT", "DELETE"],
      }),
    );
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

    c.set("role", role);
    c.set("connMgr", connMgr);
    c.set("embeddingClient", embeddingClient);
    c.set("chatClient", chatClient);

    // Soul implicit creation
    if (role === "owner" && !connMgr.soulExists(targetPubKey)) {
      connMgr.getConnection(targetPubKey, { create: true });
      logger.info({ soul: shortKey(targetPubKey) }, "Soul implicitly created");
    } else if (role === "visitor" && !connMgr.soulExists(targetPubKey)) {
      return c.json({ error: "SOUL_NOT_FOUND", message: "Soul does not exist" }, 404);
    }

    await next();
  };

  app.use("/api/:pubKey/*", injectContext);
  app.use("/api/:pubKey", injectContext);

  // Business routes
  app.route("/api", soulRoutes);
  app.route("/api", anchorRoutes);
  app.route("/api", interviewRoutes);
  app.route("/api", reasoningRoutes);
  app.route("/api", conversationRoutes);

  return { app, connMgr };
}
