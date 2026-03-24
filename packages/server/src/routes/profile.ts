import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import sharp from "sharp";
import type { ConnectionManager } from "../db/connection.js";
import type { Role } from "../middleware/role.js";

declare module "hono" {
  interface ContextVariableMap {
    role: Role;
    connMgr: ConnectionManager;
    requestBodyBytes: Buffer | undefined;
  }
}

export const PROFILE_ID = "singleton";
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const MAX_AVATAR_EDGE = 2048;
export const MAX_AVATAR_PIXELS = 2048 * 2048;

type DbConnection = ReturnType<ConnectionManager["getConnection"]>;

const profileSchema = z.object({
  displayName: z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length <= 40, { message: "displayName must be 0-40 chars" }),
  bio: z.string().max(280, { message: "bio must be 0-280 chars" }),
});

function requireOwner(c: Context): Response | null {
  if (c.get("role") !== "owner") {
    return c.json({ error: "FORBIDDEN", message: "Owner access required" }, 403);
  }
  return null;
}

async function isDecodableWebpImage(body: Buffer): Promise<boolean> {
  try {
    const image = sharp(body, { failOn: "error", animated: true });
    const metadata = await image.metadata();

    if (
      metadata.format !== "webp" ||
      (metadata.width ?? 0) <= 0 ||
      (metadata.height ?? 0) <= 0 ||
      (metadata.pages ?? 1) !== 1 ||
      (metadata.width ?? 0) > MAX_AVATAR_EDGE ||
      (metadata.height ?? 0) > MAX_AVATAR_EDGE ||
      (metadata.width ?? 0) * (metadata.height ?? 0) > MAX_AVATAR_PIXELS
    ) {
      return false;
    }

    const decoded = await sharp(body, { failOn: "error" }).ensureAlpha().raw().toBuffer();
    return decoded.length > 0;
  } catch {
    return false;
  }
}

export function readProfileSummary(conn: DbConnection) {
  const profile = conn.raw
    .prepare(
      `SELECT display_name AS displayName, bio, updated_at AS updatedAt
       FROM public_profile
       WHERE id = ?`,
    )
    .get(PROFILE_ID) as
    | { displayName: string | null; bio: string | null; updatedAt: number }
    | undefined;

  const avatar = conn.raw
    .prepare(
      `SELECT updated_at AS updatedAt
       FROM public_profile_avatar
       WHERE id = ?`,
    )
    .get(PROFILE_ID) as { updatedAt: number } | undefined;

  return {
    displayName: profile?.displayName ?? "",
    bio: profile?.bio ?? "",
    hasAvatar: Boolean(avatar),
    avatarVersion: avatar?.updatedAt ?? null,
    updatedAt: profile?.updatedAt ?? null,
  };
}

export function readProfileAvatar(conn: DbConnection): { blob: Buffer; updatedAt: number } | null {
  const avatar = conn.raw
    .prepare(
      `SELECT blob, updated_at AS updatedAt
       FROM public_profile_avatar
       WHERE id = ?`,
    )
    .get(PROFILE_ID) as { blob: Buffer; updatedAt: number } | undefined;

  return avatar ?? null;
}

export const profileRoutes = new Hono();

profileRoutes.get("/:pubKey/profile", (c) => {
  const forbidden = requireOwner(c);
  if (forbidden) return forbidden;

  const conn = c.get("connMgr").getConnection(c.req.param("pubKey"));
  return c.json({ data: readProfileSummary(conn) });
});

profileRoutes.put(
  "/:pubKey/profile",
  zValidator("json", profileSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "VALIDATION_ERROR", message: result.error.message }, 422);
    }
  }),
  (c) => {
    const forbidden = requireOwner(c);
    if (forbidden) return forbidden;

    const conn = c.get("connMgr").getConnection(c.req.param("pubKey"));
    const { displayName, bio } = c.req.valid("json");
    const updatedAt = Date.now();

    conn.raw
      .prepare(
        `INSERT INTO public_profile (id, display_name, bio, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name,
           bio = excluded.bio,
           updated_at = excluded.updated_at`,
      )
      .run(PROFILE_ID, displayName, bio, updatedAt);

    return c.json({ data: readProfileSummary(conn) });
  },
);

profileRoutes.put("/:pubKey/profile/avatar", async (c) => {
  const forbidden = requireOwner(c);
  if (forbidden) return forbidden;

  const contentType = c.req.header("Content-Type")?.split(";")[0]?.trim();
  if (contentType !== "image/webp") {
    return c.json({ error: "VALIDATION_ERROR", message: "Avatar must be image/webp" }, 422);
  }

  const contentLength = Number(c.req.header("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_AVATAR_BYTES) {
    return c.json({ error: "VALIDATION_ERROR", message: "Avatar exceeds 2MB limit" }, 422);
  }

  const requestBodyBytes = c.get("requestBodyBytes");
  const body = requestBodyBytes ?? Buffer.from(new Uint8Array(await c.req.arrayBuffer()));
  if (body.length > MAX_AVATAR_BYTES) {
    return c.json({ error: "VALIDATION_ERROR", message: "Avatar exceeds 2MB limit" }, 422);
  }

  if (!(await isDecodableWebpImage(body))) {
    return c.json(
      { error: "VALIDATION_ERROR", message: "Avatar payload must be a valid WebP image" },
      422,
    );
  }

  const conn = c.get("connMgr").getConnection(c.req.param("pubKey"));
  const updatedAt = Date.now();

  conn.raw
    .prepare(
      `INSERT INTO public_profile_avatar (id, blob, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         blob = excluded.blob,
         updated_at = excluded.updated_at`,
    )
    .run(PROFILE_ID, body, updatedAt);

  return c.body(null, 204);
});

profileRoutes.delete("/:pubKey/profile/avatar", (c) => {
  const forbidden = requireOwner(c);
  if (forbidden) return forbidden;

  const conn = c.get("connMgr").getConnection(c.req.param("pubKey"));
  conn.raw.prepare("DELETE FROM public_profile_avatar WHERE id = ?").run(PROFILE_ID);
  return c.body(null, 204);
});
