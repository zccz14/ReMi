import { Hono } from "hono";
import { base58Decode } from "@remi/crypto";
import type { ConnectionManager } from "../db/connection.js";
import { readProfileAvatar, readProfileSummary } from "./profile.js";

declare module "hono" {
  interface ContextVariableMap {
    connMgr: ConnectionManager;
  }
}

function validatePubKey(pubKey: string): string | null {
  try {
    const decoded = base58Decode(pubKey);
    if (decoded.length !== 32) {
      return "Invalid base58 public key";
    }
    return null;
  } catch {
    return "Invalid base58 public key";
  }
}

export const publicProfileRoutes = new Hono();

publicProfileRoutes.get("/public/:pubKey/profile", (c) => {
  const pubKey = c.req.param("pubKey");
  const validationError = validatePubKey(pubKey);
  if (validationError) {
    return c.json({ error: "VALIDATION_ERROR", message: validationError }, 422);
  }

  const connMgr = c.get("connMgr");

  if (!connMgr.soulExists(pubKey)) {
    return c.json({ error: "SOUL_NOT_FOUND", message: "Soul does not exist" }, 404);
  }

  return c.json({ data: readProfileSummary(connMgr.getConnection(pubKey)) });
});

publicProfileRoutes.get("/public/:pubKey/profile/avatar", (c) => {
  const pubKey = c.req.param("pubKey");
  const validationError = validatePubKey(pubKey);
  if (validationError) {
    return c.json({ error: "VALIDATION_ERROR", message: validationError }, 422);
  }

  const connMgr = c.get("connMgr");

  if (!connMgr.soulExists(pubKey)) {
    return c.json({ error: "SOUL_NOT_FOUND", message: "Soul does not exist" }, 404);
  }

  const avatar = readProfileAvatar(connMgr.getConnection(pubKey));
  if (!avatar) {
    return c.json({ error: "PROFILE_AVATAR_NOT_FOUND", message: "Avatar does not exist" }, 404);
  }

  return new Response(new Uint8Array(avatar.blob), {
    status: 200,
    headers: { "Content-Type": "image/webp" },
  });
});
