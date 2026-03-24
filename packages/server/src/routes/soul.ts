import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { base58Decode } from "@remi/crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ConnectionManager } from "../db/connection.js";
import { logger, shortKey } from "../logger.js";

const log = logger.child({ module: "soul" });

declare module "hono" {
  interface ContextVariableMap {
    connMgr: ConnectionManager;
    soulExistedBeforeRequest: boolean;
  }
}

const copySchema = z.object({
  targetPubKey: z
    .string()
    .min(1)
    .refine(
      (val) => {
        try {
          return base58Decode(val).length === 32;
        } catch {
          return false;
        }
      },
      { message: "Invalid base58 public key" },
    ),
});

export const soulRoutes = new Hono();

export function copySoulFile(srcPath: string, dstPath: string) {
  fs.copyFileSync(srcPath, dstPath, fs.constants.COPYFILE_EXCL);
}

export function mapCopySoulError(error: unknown): 404 | 409 | null {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "EEXIST") return 409;
  if (code === "ENOENT") return 404;
  return null;
}

// DELETE /:pubKey — Delete entire Soul
soulRoutes.delete("/:pubKey", (c) => {
  if (c.get("role") !== "owner") {
    return c.json({ error: "FORBIDDEN", message: "Owner access required" }, 403);
  }
  const pubKey = c.req.param("pubKey");
  const connMgr = c.get("connMgr");

  connMgr.removeConnection(pubKey);
  const dbPath = path.join(connMgr.dataDir, `${pubKey}.sqlite`);
  try {
    fs.unlinkSync(dbPath);
  } catch {
    // ignore if file already removed
  }

  log.warn({ soul: shortKey(pubKey) }, "Soul deleted");
  return c.body(null, 204);
});

// POST /:pubKey/copy — Copy Soul to new pubKey
soulRoutes.post(
  "/:pubKey/copy",
  zValidator("json", copySchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "VALIDATION_ERROR", message: result.error.message }, 422);
    }
  }),
  (c) => {
    if (c.get("role") !== "owner") {
      return c.json({ error: "FORBIDDEN", message: "Owner access required" }, 403);
    }
    const pubKey = c.req.param("pubKey");
    const { targetPubKey } = c.req.valid("json");
    const connMgr = c.get("connMgr");

    if (c.get("soulExistedBeforeRequest") === false) {
      return c.json({ error: "SOUL_NOT_FOUND", message: "Soul does not exist" }, 404);
    }

    const srcPath = path.join(connMgr.dataDir, `${pubKey}.sqlite`);
    const dstPath = path.join(connMgr.dataDir, `${targetPubKey}.sqlite`);

    if (connMgr.soulExists(targetPubKey)) {
      return c.json({ error: "COPY_TARGET_EXISTS", message: "Target soul already exists" }, 409);
    }

    try {
      copySoulFile(srcPath, dstPath);
    } catch (error) {
      const status = mapCopySoulError(error);
      if (status === 409) {
        return c.json({ error: "COPY_TARGET_EXISTS", message: "Target soul already exists" }, 409);
      }
      if (status === 404) {
        return c.json({ error: "SOUL_NOT_FOUND", message: "Soul does not exist" }, 404);
      }
      throw error;
    }

    const targetConn = connMgr.getConnection(targetPubKey, { create: false });
    targetConn.raw.exec("DELETE FROM public_profile; DELETE FROM public_profile_avatar;");

    log.info({ sourceSoul: shortKey(pubKey), targetSoul: shortKey(targetPubKey) }, "Soul copied");

    return c.json({ data: { targetPubKey } }, 201);
  },
);
