import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ConnectionManager } from "../db/connection.js";
import type { Role } from "../middleware/role.js";
import { GoalServiceError, createGoalsService } from "../goals/service.js";

declare module "hono" {
  interface ContextVariableMap {
    role: Role;
    connMgr: ConnectionManager;
  }
}

const createGoalNodeSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().optional(),
    parent_id: z.string().nullable().optional(),
    type: z.literal("goal"),
    title: z.string().trim().min(1),
    objective: z.string().trim().min(1),
    status: z.enum(["todo", "blocked", "done", "cancelled"]).optional(),
    dependency_ids: z.array(z.string()).optional(),
    execution_base_url: z.string().optional(),
    external_session_id: z.string().optional(),
  }),
  z.object({
    id: z.string().optional(),
    parent_id: z.string().trim().min(1),
    type: z.literal("session"),
    title: z.string().trim().min(1),
    objective: z.string().trim().min(1),
    status: z.enum(["todo", "blocked", "done", "cancelled"]).optional(),
    dependency_ids: z.array(z.string()).optional(),
    execution_base_url: z.string().optional(),
    external_session_id: z.string().optional(),
  }),
]);

const updateGoalNodeSchema = z.object({
  status: z.enum(["done", "cancelled"]),
});

function requireOwner(c: Context) {
  if (c.get("role") !== "owner") {
    return c.json({ error: "FORBIDDEN", message: "Owner access required" }, 403);
  }

  return null;
}

function handleRouteError(c: Context, error: unknown) {
  if (error instanceof GoalServiceError) {
    return c.json({ error: error.code, message: error.message }, error.status as 404 | 422);
  }

  throw error;
}

export const goalsRoutes = new Hono();

goalsRoutes.get("/:pubKey/goals", (c) => {
  const forbidden = requireOwner(c);
  if (forbidden) {
    return forbidden;
  }

  const conn = c.get("connMgr").getConnection(c.req.param("pubKey"));
  const service = createGoalsService(conn);
  return c.json({ data: service.listTree() });
});

goalsRoutes.post("/:pubKey/goals", async (c) => {
  const forbidden = requireOwner(c);
  if (forbidden) {
    return forbidden;
  }

  try {
    const input = createGoalNodeSchema.parse(await c.req.json());
    const conn = c.get("connMgr").getConnection(c.req.param("pubKey"));
    const service = createGoalsService(conn);

    const data =
      input.type === "session"
        ? service.createSessionNode({
            id: input.id,
            parent_id: input.parent_id,
            title: input.title,
            objective: input.objective,
            status: input.status,
            dependency_ids: input.dependency_ids,
            execution_base_url: input.execution_base_url,
            external_session_id: input.external_session_id,
          })
        : service.createGoalNode({
            id: input.id,
            parent_id: input.parent_id,
            title: input.title,
            objective: input.objective,
            status: input.status,
            dependency_ids: input.dependency_ids,
            execution_base_url: input.execution_base_url,
            external_session_id: input.external_session_id,
          });

    return c.json({ data }, 201);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: "VALIDATION_ERROR", message: error.message }, 422);
    }

    return handleRouteError(c, error);
  }
});

goalsRoutes.patch("/:pubKey/goals/:nodeId", async (c) => {
  const forbidden = requireOwner(c);
  if (forbidden) {
    return forbidden;
  }

  try {
    const input = updateGoalNodeSchema.parse(await c.req.json());
    const conn = c.get("connMgr").getConnection(c.req.param("pubKey"));
    const service = createGoalsService(conn);
    const data = service.updateNodeStatus(c.req.param("nodeId"), input.status);
    return c.json({ data });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: "VALIDATION_ERROR", message: error.message }, 422);
    }

    return handleRouteError(c, error);
  }
});
