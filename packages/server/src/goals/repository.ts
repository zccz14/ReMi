import { eq, sql } from "drizzle-orm";
import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { goalNodes } from "../db/schema.js";
import {
  EXECUTION_SESSION_STATUSES,
  GOAL_NODE_CHILD_LIMIT,
  GOAL_STATUS_VALUES,
  SESSION_STATUS_VALUES,
} from "./constants.js";
import type {
  CreateChildGoalInput,
  ExecutionSessionStatus,
  CreateRootGoalInput,
  CreateSessionNodeInput,
  GoalNode,
  GoalStatus,
  GoalNodeStatus,
  SessionLocalStatus,
  SessionStatus,
} from "./types.js";

interface GoalNodesRepositoryConnection {
  drizzle: BetterSQLite3Database;
  raw: Database.Database;
}

type GoalNodeRow = typeof goalNodes.$inferSelect;

function serializeDependencyIds(dependencyIds: string[] | undefined) {
  return JSON.stringify(dependencyIds ?? []);
}

function deserializeDependencyIds(value: string) {
  const parsed = JSON.parse(value) as unknown;

  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("dependency_ids must be a string array");
  }

  return parsed;
}

function readDependencyIds(row: Pick<GoalNodeRow, "id" | "dependency_ids">) {
  try {
    return deserializeDependencyIds(row.dependency_ids);
  } catch (error) {
    throw new Error(`invalid dependency_ids for goal node ${row.id}`, {
      cause: error,
    });
  }
}

function mapGoalNode(row: GoalNodeRow): GoalNode {
  const dependency_ids = readDependencyIds(row);

  if (row.type === "session") {
    return {
      id: row.id,
      parent_id: row.parent_id,
      type: "session",
      title: row.title,
      objective: row.objective,
      status: row.status as SessionStatus,
      dependency_ids,
      execution_base_url: row.execution_base_url as string,
      external_session_id: row.external_session_id as string,
    };
  }

  return {
    id: row.id,
    parent_id: row.parent_id,
    type: "goal",
    title: row.title,
    objective: row.objective,
    status: row.status as GoalStatus,
    dependency_ids,
    execution_base_url: null,
    external_session_id: null,
  };
}

function assertGoalStatus(status: GoalNodeStatus): asserts status is GoalStatus {
  if (!(GOAL_STATUS_VALUES as readonly string[]).includes(status)) {
    throw new Error("goal nodes cannot use running status");
  }
}

function assertGoalDependenciesResolved(
  conn: GoalNodesRepositoryConnection,
  row: GoalNodeRow,
  status: GoalStatus,
) {
  const dependency_ids = readDependencyIds(row);
  const satisfied = dependenciesSatisfied(conn, dependency_ids);

  if (status === "done" && !satisfied) {
    throw new Error("goal dependencies must be done before completion");
  }

  if (status === "blocked" && satisfied) {
    throw new Error("blocked status requires unmet dependencies");
  }
}

function assertLocalStatusDependenciesResolved(
  conn: GoalNodesRepositoryConnection,
  row: GoalNodeRow,
  status: GoalStatus | SessionLocalStatus,
) {
  const dependency_ids = readDependencyIds(row);
  const satisfied = dependenciesSatisfied(conn, dependency_ids);

  if (status === "done" && !satisfied) {
    throw new Error("dependencies must be done before completion");
  }

  if (status === "blocked" && satisfied) {
    throw new Error("blocked status requires unmet dependencies");
  }
}

function assertSessionStatus(status: GoalNodeStatus): asserts status is SessionStatus {
  if (!(SESSION_STATUS_VALUES as readonly string[]).includes(status)) {
    throw new Error("session nodes cannot use running status here");
  }
}

function assertExecutionSessionStatus(status: string): asserts status is ExecutionSessionStatus {
  if (!(EXECUTION_SESSION_STATUSES as readonly string[]).includes(status)) {
    throw new Error("unknown execution session status");
  }
}

function assertSessionLocalStatus(status: GoalNodeStatus): asserts status is SessionLocalStatus {
  if (status === "running" || !(SESSION_STATUS_VALUES as readonly string[]).includes(status)) {
    throw new Error("session nodes cannot use running status here");
  }
}

function assertSessionCreateStatus(status: GoalNodeStatus) {
  if (status === "running") {
    throw new Error("session nodes cannot use running status here");
  }

  assertSessionStatus(status);
}

function assertRootDependencies(dependencyIds: string[] | undefined) {
  if ((dependencyIds ?? []).length > 0) {
    throw new Error("root goals cannot declare dependencies");
  }
}

function assertSessionFields(input: {
  execution_base_url?: string | null;
  external_session_id?: string | null;
}) {
  if (!input.execution_base_url) {
    throw new Error("execution_base_url is required");
  }

  if (!input.external_session_id) {
    throw new Error("external_session_id is required");
  }
}

function getNodeById(conn: GoalNodesRepositoryConnection, id: string) {
  return conn.drizzle.select().from(goalNodes).where(eq(goalNodes.id, id)).get() as
    | GoalNodeRow
    | undefined;
}

function countChildren(conn: GoalNodesRepositoryConnection, parentId: string) {
  return conn.drizzle.select().from(goalNodes).where(eq(goalNodes.parent_id, parentId)).all()
    .length;
}

function assertGoalParent(conn: GoalNodesRepositoryConnection, parentId: string) {
  const parent = getNodeById(conn, parentId);
  if (!parent) {
    throw new Error("parent goal does not exist");
  }

  if (parent.type !== "goal") {
    throw new Error("parent node must be a goal");
  }

  return parent;
}

function getRootId(conn: GoalNodesRepositoryConnection, nodeId: string) {
  let current = getNodeById(conn, nodeId);

  while (current?.parent_id) {
    current = getNodeById(conn, current.parent_id);
  }

  return current?.id;
}

function isAncestorOf(
  conn: GoalNodesRepositoryConnection,
  ancestorId: string,
  nodeId: string | null,
) {
  let currentId = nodeId;

  while (currentId) {
    if (currentId === ancestorId) {
      return true;
    }

    currentId = getNodeById(conn, currentId)?.parent_id ?? null;
  }

  return false;
}

function assertDependencies(
  conn: GoalNodesRepositoryConnection,
  input: { id: string; parent_id: string | null; dependency_ids?: string[] },
) {
  const dependencyIds = input.dependency_ids ?? [];
  const nodeRootId = input.parent_id ? getRootId(conn, input.parent_id) : input.id;

  for (const dependencyId of dependencyIds) {
    if (dependencyId === input.id) {
      throw new Error("node cannot depend on itself");
    }

    const dependency = getNodeById(conn, dependencyId);
    if (!dependency) {
      throw new Error("dependency does not exist");
    }

    const dependencyRootId = getRootId(conn, dependencyId);
    if (nodeRootId !== dependencyRootId) {
      throw new Error("dependency must stay within the same tree");
    }

    if (isAncestorOf(conn, dependencyId, input.parent_id)) {
      throw new Error("dependency would create a cycle");
    }
  }
}

function deriveInitialStatus(
  conn: GoalNodesRepositoryConnection,
  status: GoalNodeStatus,
  dependencyIds: string[] | undefined,
) {
  const satisfied = dependenciesSatisfied(conn, dependencyIds);

  if (status === "blocked" && satisfied) {
    throw new Error("blocked status requires unmet dependencies");
  }

  if (status === "done" && !satisfied) {
    throw new Error("dependencies must be done before completion");
  }

  if (status !== "todo") {
    return status;
  }

  for (const dependencyId of dependencyIds ?? []) {
    const dependency = getNodeById(conn, dependencyId);
    if (dependency && dependency.status !== "done") {
      return "blocked" satisfies GoalNodeStatus;
    }
  }

  return status;
}

function deriveDependencyAwareStatus(
  conn: GoalNodesRepositoryConnection,
  status: GoalNodeStatus,
  dependencyIds: string[] | undefined,
) {
  if (status === "todo" || status === "running") {
    for (const dependencyId of dependencyIds ?? []) {
      const dependency = getNodeById(conn, dependencyId);
      if (dependency && dependency.status !== "done") {
        return "blocked" satisfies GoalNodeStatus;
      }
    }
  }

  return status;
}

function dependenciesSatisfied(
  conn: GoalNodesRepositoryConnection,
  dependencyIds: string[] | undefined,
) {
  for (const dependencyId of dependencyIds ?? []) {
    const dependency = getNodeById(conn, dependencyId);
    if (!dependency || dependency.status !== "done") {
      return false;
    }
  }

  return true;
}

function recomputeStoredStatus(
  conn: GoalNodesRepositoryConnection,
  row: GoalNodeRow,
): GoalNodeStatus {
  if (row.status === "cancelled") {
    return "cancelled";
  }

  if (row.type === "session" && row.status === "done") {
    return "done";
  }

  const dependencyIds = readDependencyIds(row);
  if (!dependenciesSatisfied(conn, dependencyIds)) {
    return "blocked";
  }

  if (row.status === "done") {
    return "done";
  }

  if (row.type === "session" && row.status === "running") {
    return "running";
  }

  return "todo";
}

function listDependents(conn: GoalNodesRepositoryConnection, dependencyId: string) {
  const rows = conn.drizzle.select().from(goalNodes).all() as GoalNodeRow[];
  return rows.filter((row) => readDependencyIds(row).includes(dependencyId));
}

function propagateDependentStatuses(conn: GoalNodesRepositoryConnection, dependencyId: string) {
  const visited = new Set<string>();
  const queue = [dependencyId];

  while (queue.length > 0) {
    const currentId = queue.shift() as string;
    for (const dependent of listDependents(conn, currentId)) {
      if (visited.has(dependent.id)) {
        continue;
      }

      visited.add(dependent.id);
      const nextStatus = recomputeStoredStatus(conn, dependent);
      if (nextStatus !== dependent.status) {
        conn.drizzle
          .update(goalNodes)
          .set({ status: nextStatus })
          .where(eq(goalNodes.id, dependent.id))
          .run();
      }

      queue.push(dependent.id);
    }
  }
}

function persistStatus(
  conn: GoalNodesRepositoryConnection,
  row: GoalNodeRow,
  status: GoalNodeStatus,
) {
  const nextStatus = deriveDependencyAwareStatus(conn, status, readDependencyIds(row));

  conn.drizzle.update(goalNodes).set({ status: nextStatus }).where(eq(goalNodes.id, row.id)).run();

  propagateDependentStatuses(conn, row.id);

  const updatedRow = conn.drizzle.select().from(goalNodes).where(eq(goalNodes.id, row.id)).get() as
    | GoalNodeRow
    | undefined;

  return updatedRow ? mapGoalNode(updatedRow) : null;
}

function withImmediateTransaction<T>(conn: GoalNodesRepositoryConnection, action: () => T) {
  conn.raw.exec("BEGIN IMMEDIATE");

  try {
    const result = action();
    conn.raw.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      conn.raw.exec("ROLLBACK");
    } catch {
      // ignore rollback failures after a failed write
    }

    throw error;
  }
}

function deriveRefreshStatus(
  conn: GoalNodesRepositoryConnection,
  row: GoalNodeRow,
  executionStatus: ExecutionSessionStatus,
): GoalNodeStatus {
  if (row.status === "cancelled") {
    return "cancelled";
  }

  if (executionStatus === "cancelled") {
    return "cancelled";
  }

  if (row.status === "done") {
    return "done";
  }

  const dependency_ids = readDependencyIds(row);

  return deriveDependencyAwareStatus(
    conn,
    executionStatus === "running" ? "running" : "todo",
    dependency_ids,
  );
}

function insertGoalNode(
  conn: GoalNodesRepositoryConnection,
  input: {
    id: string;
    parent_id: string | null;
    type: GoalNode["type"];
    title: string;
    objective: string;
    status: GoalNodeStatus;
    dependency_ids?: string[];
    execution_base_url?: string | null;
    external_session_id?: string | null;
  },
) {
  const values = {
    id: input.id,
    parent_id: input.parent_id,
    type: input.type,
    title: input.title,
    objective: input.objective,
    status: deriveInitialStatus(conn, input.status, input.dependency_ids),
    dependency_ids: serializeDependencyIds(input.dependency_ids),
    execution_base_url: input.execution_base_url ?? null,
    external_session_id: input.external_session_id ?? null,
  };

  if (input.parent_id) {
    const result = conn.drizzle.run(sql`
      INSERT INTO goal_nodes (
        id,
        parent_id,
        type,
        title,
        objective,
        status,
        dependency_ids,
        execution_base_url,
        external_session_id
      )
      SELECT
        ${values.id},
        ${values.parent_id},
        ${values.type},
        ${values.title},
        ${values.objective},
        ${values.status},
        ${values.dependency_ids},
        ${values.execution_base_url},
        ${values.external_session_id}
      WHERE (
        SELECT COUNT(*)
        FROM goal_nodes
        WHERE parent_id = ${input.parent_id}
      ) < ${GOAL_NODE_CHILD_LIMIT}
    `);

    if (result.changes !== 1) {
      throw new Error("parent already has maximum children");
    }
  } else {
    conn.drizzle.insert(goalNodes).values(values).run();
  }

  const row = conn.drizzle
    .select()
    .from(goalNodes)
    .where(eq(goalNodes.id, input.id))
    .get() as GoalNodeRow;
  return mapGoalNode(row);
}

export function createGoalsRepository(conn: GoalNodesRepositoryConnection) {
  return {
    createRootGoal(input: CreateRootGoalInput) {
      const id = input.id ?? crypto.randomUUID();
      assertGoalStatus(input.status);
      assertRootDependencies(input.dependency_ids);
      return insertGoalNode(conn, {
        ...input,
        id,
        parent_id: null,
        type: "goal",
      });
    },

    createChildGoal(input: CreateChildGoalInput) {
      const id = input.id ?? crypto.randomUUID();
      return withImmediateTransaction(conn, () => {
        assertGoalStatus(input.status);
        assertGoalParent(conn, input.parent_id);
        if (countChildren(conn, input.parent_id) >= GOAL_NODE_CHILD_LIMIT) {
          throw new Error("parent already has maximum children");
        }
        assertDependencies(conn, {
          id,
          parent_id: input.parent_id,
          dependency_ids: input.dependency_ids,
        });
        return insertGoalNode(conn, {
          ...input,
          id,
          type: "goal",
        });
      });
    },

    createSessionNode(input: CreateSessionNodeInput) {
      const id = input.id ?? crypto.randomUUID();
      return withImmediateTransaction(conn, () => {
        assertSessionCreateStatus(input.status);
        assertSessionFields(input);
        assertGoalParent(conn, input.parent_id);
        if (countChildren(conn, input.parent_id) >= GOAL_NODE_CHILD_LIMIT) {
          throw new Error("parent already has maximum children");
        }
        assertDependencies(conn, {
          id,
          parent_id: input.parent_id,
          dependency_ids: input.dependency_ids,
        });
        return insertGoalNode(conn, {
          ...input,
          id,
          type: "session",
        });
      });
    },

    listChildren(parentId: string) {
      const rows = conn.drizzle
        .select()
        .from(goalNodes)
        .where(eq(goalNodes.parent_id, parentId))
        .orderBy(sql`rowid asc`)
        .all() as GoalNodeRow[];

      return rows.map(mapGoalNode);
    },

    updateGoalLocalStatus(id: string, status: GoalStatus) {
      const row = conn.drizzle.select().from(goalNodes).where(eq(goalNodes.id, id)).get() as
        | GoalNodeRow
        | undefined;

      if (!row) {
        return null;
      }

      if (row.type !== "goal") {
        throw new Error("goal local update requires a goal node");
      }

      assertGoalStatus(status);
      assertGoalDependenciesResolved(conn, row, status);

      return persistStatus(conn, row, status);
    },

    updateSessionLocalStatus(id: string, status: SessionLocalStatus) {
      const row = conn.drizzle.select().from(goalNodes).where(eq(goalNodes.id, id)).get() as
        | GoalNodeRow
        | undefined;

      if (!row) {
        return null;
      }

      if (row.type !== "session") {
        throw new Error("session local update requires a session node");
      }

      assertSessionLocalStatus(status);
      assertLocalStatusDependenciesResolved(conn, row, status);

      return persistStatus(conn, row, status);
    },

    applySessionRefreshStatus(id: string, status: ExecutionSessionStatus) {
      const row = conn.drizzle.select().from(goalNodes).where(eq(goalNodes.id, id)).get() as
        | GoalNodeRow
        | undefined;

      if (!row) {
        return null;
      }

      if (row.type !== "session") {
        throw new Error("session refresh requires a session node");
      }

      assertExecutionSessionStatus(status);
      return persistStatus(conn, row, deriveRefreshStatus(conn, row, status));
    },
  };
}

export { GOAL_NODE_CHILD_LIMIT };
