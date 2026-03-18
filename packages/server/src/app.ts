import { Hono, type Context, type Next } from "hono";
import { authMiddleware } from "./middleware/hono-auth.js";
import { determineRole } from "./middleware/role.js";
import { ConnectionManager } from "./db/connection.js";
import { type EmbeddingClient } from "./embedding/client.js";
import { healthRoutes } from "./routes/health.js";
import { anchorRoutes } from "./routes/anchors.js";
import { soulRoutes } from "./routes/soul.js";

interface AppConfig {
  dataDir: string;
  maxConnections?: number;
  embeddingDimensions?: number;
  embeddingClient?: EmbeddingClient | null;
}

export function createApp(config: AppConfig) {
  const connMgr = new ConnectionManager(config.dataDir, {
    maxSize: config.maxConnections,
    embeddingDimensions: config.embeddingDimensions,
  });

  const app = new Hono();

  // Health check (no auth required)
  app.route("/api", healthRoutes);

  // Auth-required routes
  app.use("/api/:pubKey/*", authMiddleware());
  app.use("/api/:pubKey", authMiddleware());

  const embeddingClient = config.embeddingClient ?? null;

  // Inject role + connMgr + embeddingClient
  const injectContext = async (c: Context, next: Next) => {
    const signerPubKey = c.get("signerPubKey");
    const targetPubKey = c.req.param("pubKey");
    const role = determineRole(signerPubKey, targetPubKey);

    c.set("role", role);
    c.set("connMgr", connMgr);
    c.set("embeddingClient", embeddingClient);

    // Soul implicit creation
    if (role === "owner" && !connMgr.soulExists(targetPubKey)) {
      connMgr.getConnection(targetPubKey, { create: true });
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

  return { app, connMgr };
}
