import { createMiddleware } from "hono/factory";
import { verifyRequest } from "./auth.js";
import { logger, shortKey } from "../logger.js";

const log = logger.child({ module: "auth" });
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

declare module "hono" {
  interface ContextVariableMap {
    signerPubKey: string;
    requestBodyBytes: Buffer | undefined;
  }
}

export async function readRequestBodyBuffer(
  request: Request,
  maxBytes?: number,
): Promise<Buffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }

  const body = request.body;
  if (!body) {
    return Buffer.alloc(0);
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = Buffer.from(value);
    total += chunk.length;

    if (maxBytes !== undefined && total > maxBytes) {
      await reader.cancel("body-too-large");
      throw new Error("BODY_TOO_LARGE");
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks, total);
}

export function authMiddleware() {
  return createMiddleware(async (c, next) => {
    const publicKey = c.req.header("X-Public-Key");
    const timestamp = c.req.header("X-Timestamp");
    const signature = c.req.header("X-Signature");
    const pathname = new URL(c.req.url).pathname;
    const contentLength = Number(c.req.header("Content-Length"));

    if (
      c.req.method === "PUT" &&
      pathname.endsWith("/profile/avatar") &&
      Number.isFinite(contentLength) &&
      contentLength > MAX_AVATAR_BYTES
    ) {
      return c.json({ error: "VALIDATION_ERROR", message: "Avatar exceeds 2MB limit" }, 422);
    }

    const isAvatarUpload = c.req.method === "PUT" && pathname.endsWith("/profile/avatar");
    let body: Buffer | undefined;

    if (isAvatarUpload) {
      try {
        body = await readRequestBodyBuffer(c.req.raw, MAX_AVATAR_BYTES);
      } catch (error) {
        if (error instanceof Error && error.message === "BODY_TOO_LARGE") {
          return c.json({ error: "VALIDATION_ERROR", message: "Avatar exceeds 2MB limit" }, 422);
        }
        throw error;
      }
    } else if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      body = Buffer.from(new Uint8Array(await c.req.arrayBuffer()));
    }

    const result = await verifyRequest({
      method: c.req.method,
      path: pathname,
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
          path: pathname,
        },
        "Auth failed",
      );
      return c.json({ error: result.error, message: result.message }, 401);
    }

    c.set("signerPubKey", result.publicKey);
    c.set("requestBodyBytes", body);
    await next();
  });
}
