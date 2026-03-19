import { createMiddleware } from "hono/factory";
import { verifyRequest } from "./auth.js";
import { logger, shortKey } from "../logger.js";

const log = logger.child({ module: "auth" });

declare module "hono" {
  interface ContextVariableMap {
    signerPubKey: string;
  }
}

export function authMiddleware() {
  return createMiddleware(async (c, next) => {
    const publicKey = c.req.header("X-Public-Key");
    const timestamp = c.req.header("X-Timestamp");
    const signature = c.req.header("X-Signature");

    let body: Uint8Array | undefined;
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      body = new Uint8Array(await c.req.arrayBuffer());
    }

    const result = await verifyRequest({
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      timestamp,
      publicKey,
      signature,
      body,
    });

    if (!result.ok) {
      log.warn(
        {
          error: result.error,
          signer: publicKey ? shortKey(publicKey) : "missing",
          path: new URL(c.req.url).pathname,
        },
        "Auth failed",
      );
      return c.json({ error: result.error, message: result.message }, 401);
    }

    c.set("signerPubKey", result.publicKey);
    await next();
  });
}
