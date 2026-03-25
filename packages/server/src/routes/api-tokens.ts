import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { apiTokens } from "../db/schema.js";
import type { ConnectionManager } from "../db/connection.js";
import type { Role } from "../middleware/role.js";

declare module "hono" {
  interface ContextVariableMap {
    role: Role;
    connMgr: ConnectionManager;
  }
}

const createApiTokenSchema = z.object({
  note: z.string().trim().min(1),
});

function requireOwner(c: Context): Response | null {
  if (c.get("role") !== "owner") {
    return c.json({ error: "FORBIDDEN", message: "Owner access required" }, 403);
  }
  return null;
}

function generateApiTokenId() {
  return `sk-${crypto.randomUUID().replaceAll("-", "")}`;
}

function buildTokenPrefix(id: string) {
  return `${id.slice(0, 6)}...`;
}

function getPubKey(c: Context) {
  return c.req.param("pubKey") as string;
}

export function apiTokensRoutes() {
  const routes = new Hono();

  routes.post(
    "/",
    zValidator("json", createApiTokenSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "VALIDATION_ERROR", message: result.error.message }, 422);
      }
    }),
    (c) => {
      const forbidden = requireOwner(c);
      if (forbidden) return forbidden;

      const conn = c.get("connMgr").getConnection(getPubKey(c));
      const createdAt = new Date().toISOString();
      const id = generateApiTokenId();
      const body = c.req.valid("json");

      conn.drizzle.insert(apiTokens).values({ id, note: body.note, createdAt }).run();

      return c.json({ id, note: body.note, createdAt }, 201);
    },
  );

  routes.get("/", (c) => {
    const forbidden = requireOwner(c);
    if (forbidden) return forbidden;

    const conn = c.get("connMgr").getConnection(getPubKey(c));
    const items = conn.drizzle
      .select()
      .from(apiTokens)
      .orderBy(desc(apiTokens.createdAt))
      .all()
      .map((item) => ({
        id: item.id,
        tokenPrefix: buildTokenPrefix(item.id),
        note: item.note,
        createdAt: item.createdAt,
      }));

    return c.json({ items });
  });

  routes.delete("/:id", (c) => {
    const forbidden = requireOwner(c);
    if (forbidden) return forbidden;

    const conn = c.get("connMgr").getConnection(getPubKey(c));
    conn.drizzle
      .delete(apiTokens)
      .where(eq(apiTokens.id, c.req.param("id")))
      .run();
    return c.body(null, 204);
  });

  return routes;
}
