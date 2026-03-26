import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { GOAL_NODE_CHILD_LIMIT, GOAL_STATUS_VALUES, SESSION_STATUS_VALUES } from "./constants.js";
import type {
  CreateChildGoalInput,
  CreateRootGoalInput,
  CreateSessionNodeInput,
  GoalNode,
  GoalNodeStatus,
  GoalStatus,
  SessionLocalStatus,
  SessionStatus,
} from "./types.js";

interface GoalsServiceConnection {
  drizzle: BetterSQLite3Database;
  raw: Database.Database;
}

interface GoalNodeRow {
  id: string;
  parent_id: string | null;
  type: GoalNode["type"];
  title: string;
  objective: string;
  status: GoalNodeStatus;
  dependency_ids: string;
  execution_base_url: string | null;
  external_session_id: string | null;
}

export interface CreateGoalNodeInput extends Partial<Pick<CreateChildGoalInput, "id">> {
  parent_id?: string | null;
  title: string;
  objective: string;
  status?: GoalStatus;
  dependency_ids?: string[];
  execution_base_url?: string | null;
  external_session_id?: string | null;
  cancel_node_id?: string;
  replace_node_id?: string;
}

export interface CreateActivationSessionNodeInput extends Partial<
  Pick<CreateSessionNodeInput, "id">
> {
  parent_id: string;
  title: string;
  objective: string;
  status?: SessionLocalStatus;
  dependency_ids?: string[];
  execution_base_url?: string;
  external_session_id?: string;
  cancel_node_id?: string;
  replace_node_id?: string;
}

export class GoalServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "GoalServiceError";
  }
}

function asValidationError(message: string) {
  return new GoalServiceError(message, 422, "VALIDATION_ERROR");
}

function asNotFoundError(message: string) {
  return new GoalServiceError(message, 404, "NOT_FOUND");
}

function serializeDependencyIds(dependencyIds: string[] | undefined) {
  return JSON.stringify(dependencyIds ?? []);
}

function deserializeDependencyIds(value: string) {
  const parsed = JSON.parse(value) as unknown;

  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw asValidationError("dependency_ids must be a string array");
  }

  return parsed;
}

function mapGoalNode(row: GoalNodeRow): GoalNode {
  const dependency_ids = deserializeDependencyIds(row.dependency_ids);

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

function isGoalStatus(status: string): status is GoalStatus {
  return (GOAL_STATUS_VALUES as readonly string[]).includes(status);
}

function isSessionLocalStatus(status: string): status is SessionLocalStatus {
  return status !== "running" && (SESSION_STATUS_VALUES as readonly string[]).includes(status);
}

function getRowById(conn: GoalsServiceConnection, id: string) {
  return conn.raw.prepare("SELECT * FROM goal_nodes WHERE id = ?").get(id) as
    | GoalNodeRow
    | undefined;
}

function listRows(conn: GoalsServiceConnection) {
  return conn.raw.prepare("SELECT * FROM goal_nodes ORDER BY rowid ASC").all() as GoalNodeRow[];
}

function listDependents(conn: GoalsServiceConnection, dependencyId: string) {
  return listRows(conn).filter((row) =>
    deserializeDependencyIds(row.dependency_ids).includes(dependencyId),
  );
}

function dependenciesSatisfied(conn: GoalsServiceConnection, dependencyIds: string[]) {
  return dependencyIds.every((dependencyId) => getRowById(conn, dependencyId)?.status === "done");
}

function recomputeStoredStatus(conn: GoalsServiceConnection, row: GoalNodeRow) {
  if (row.status === "cancelled") {
    return "cancelled" satisfies GoalNodeStatus;
  }

  if (row.type === "session" && row.status === "done") {
    return "done" satisfies GoalNodeStatus;
  }

  const dependencyIds = deserializeDependencyIds(row.dependency_ids);
  if (!dependenciesSatisfied(conn, dependencyIds)) {
    return "blocked" satisfies GoalNodeStatus;
  }

  if (row.status === "done") {
    return "done" satisfies GoalNodeStatus;
  }

  if (row.type === "session" && row.status === "running") {
    return "running" satisfies GoalNodeStatus;
  }

  return "todo" satisfies GoalNodeStatus;
}

function propagateDependentStatuses(conn: GoalsServiceConnection, dependencyId: string) {
  const queue = [dependencyId];
  const queued = new Set<string>([dependencyId]);

  while (queue.length > 0) {
    const currentId = queue.shift() as string;
    queued.delete(currentId);

    for (const dependent of listDependents(conn, currentId)) {
      const nextStatus = recomputeStoredStatus(conn, dependent);
      if (nextStatus !== dependent.status) {
        conn.raw
          .prepare("UPDATE goal_nodes SET status = ? WHERE id = ?")
          .run(nextStatus, dependent.id);

        if (!queued.has(dependent.id)) {
          queue.push(dependent.id);
          queued.add(dependent.id);
        }
      }
    }
  }
}

function persistStatus(conn: GoalsServiceConnection, row: GoalNodeRow, status: GoalNodeStatus) {
  conn.raw.prepare("UPDATE goal_nodes SET status = ? WHERE id = ?").run(status, row.id);
  propagateDependentStatuses(conn, row.id);

  const updated = getRowById(conn, row.id);
  if (!updated) {
    throw asNotFoundError(`goal node ${row.id} not found`);
  }

  return mapGoalNode(updated);
}

function withImmediateTransaction<T>(conn: GoalsServiceConnection, action: () => T) {
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

function getRootId(conn: GoalsServiceConnection, nodeId: string) {
  let current = getRowById(conn, nodeId);

  while (current?.parent_id) {
    current = getRowById(conn, current.parent_id);
  }

  return current?.id;
}

function isAncestorOf(conn: GoalsServiceConnection, ancestorId: string, nodeId: string | null) {
  let currentId = nodeId;

  while (currentId) {
    if (currentId === ancestorId) {
      return true;
    }

    currentId = getRowById(conn, currentId)?.parent_id ?? null;
  }

  return false;
}

function dependsOnTransitively(
  conn: GoalsServiceConnection,
  sourceId: string,
  targetId: string,
  visited = new Set<string>(),
): boolean {
  if (sourceId === targetId) {
    return true;
  }

  if (visited.has(sourceId)) {
    return false;
  }

  visited.add(sourceId);
  const row = getRowById(conn, sourceId);
  if (!row) {
    return false;
  }

  return deserializeDependencyIds(row.dependency_ids).some((dependencyId) =>
    dependsOnTransitively(conn, dependencyId, targetId, visited),
  );
}

function deriveInitialStatus(
  conn: GoalsServiceConnection,
  status: GoalNodeStatus,
  dependencyIds: string[],
) {
  const satisfied = dependenciesSatisfied(conn, dependencyIds);

  if (status === "blocked" && satisfied) {
    throw asValidationError("blocked status requires unmet dependencies");
  }

  if (status === "done" && !satisfied) {
    throw asValidationError("dependencies must be done before completion");
  }

  if (status === "todo" && !satisfied) {
    return "blocked" satisfies GoalNodeStatus;
  }

  return status;
}

function assertGoalStatus(status: string): asserts status is GoalStatus {
  if (!isGoalStatus(status)) {
    throw asValidationError("goal nodes cannot use running status");
  }
}

function assertSessionLocalStatus(status: string): asserts status is SessionLocalStatus {
  if (!isSessionLocalStatus(status)) {
    throw asValidationError("session nodes cannot use running status here");
  }
}

function assertGoalParent(conn: GoalsServiceConnection, parentId: string) {
  const parent = getRowById(conn, parentId);
  if (!parent) {
    throw asValidationError("parent goal does not exist");
  }

  if (parent.type !== "goal") {
    throw asValidationError("parent node must be a goal");
  }

  return parent;
}

function assertGoalNodeDoesNotUseSessionFields(input: {
  execution_base_url?: string | null;
  external_session_id?: string | null;
}) {
  if (input.execution_base_url || input.external_session_id) {
    throw asValidationError("goal nodes cannot include session fields");
  }
}

function assertSessionFields(input: {
  execution_base_url?: string | null;
  external_session_id?: string | null;
}) {
  if (!input.execution_base_url) {
    throw asValidationError("execution_base_url is required");
  }

  if (!input.external_session_id) {
    throw asValidationError("external_session_id is required");
  }
}

function assertDependencies(
  conn: GoalsServiceConnection,
  input: { id: string; parent_id: string | null; dependency_ids?: string[] },
) {
  const dependencyIds = input.dependency_ids ?? [];
  const nodeRootId = input.parent_id ? getRootId(conn, input.parent_id) : input.id;

  for (const dependencyId of dependencyIds) {
    if (dependencyId === input.id) {
      throw asValidationError("node cannot depend on itself");
    }

    const dependency = getRowById(conn, dependencyId);
    if (!dependency) {
      throw asValidationError("dependency does not exist");
    }

    if (getRootId(conn, dependencyId) !== nodeRootId) {
      throw asValidationError("dependency must stay within the same tree");
    }

    if (isAncestorOf(conn, dependencyId, input.parent_id)) {
      throw asValidationError("dependency would create a cycle");
    }

    if (isAncestorOf(conn, input.id, dependencyId)) {
      throw asValidationError("dependency would create a cycle");
    }

    if (dependsOnTransitively(conn, dependencyId, input.id)) {
      throw asValidationError("dependency would create a cycle");
    }
  }
}

function countActiveChildren(conn: GoalsServiceConnection, parentId: string) {
  const result = conn.raw
    .prepare(
      "SELECT COUNT(*) AS count FROM goal_nodes WHERE parent_id = ? AND status != 'cancelled'",
    )
    .get(parentId) as { count: number };
  return result.count;
}

function assertRoomStrategy(room: { cancel_node_id?: string; replace_node_id?: string }) {
  if (room.cancel_node_id && room.replace_node_id) {
    throw asValidationError("choose either cancel_node_id or replace_node_id");
  }
}

function makeRoomIfNeeded(
  conn: GoalsServiceConnection,
  parentId: string,
  room: { cancel_node_id?: string; replace_node_id?: string },
) {
  assertRoomStrategy(room);

  if (countActiveChildren(conn, parentId) < GOAL_NODE_CHILD_LIMIT) {
    return;
  }

  const targetId = room.replace_node_id ?? room.cancel_node_id;
  if (!targetId) {
    throw asValidationError("parent already has maximum children");
  }

  const target = getRowById(conn, targetId);
  if (!target || target.parent_id !== parentId) {
    throw asValidationError("room-making node must be an existing child of the same parent");
  }

  if (target.status !== "cancelled") {
    persistStatus(conn, target, "cancelled");
  }

  if (countActiveChildren(conn, parentId) >= GOAL_NODE_CHILD_LIMIT) {
    throw asValidationError("parent already has maximum children");
  }
}

function insertGoalNode(
  conn: GoalsServiceConnection,
  input: {
    id: string;
    parent_id: string | null;
    type: GoalNode["type"];
    title: string;
    objective: string;
    status: GoalNodeStatus;
    dependency_ids: string[];
    execution_base_url?: string | null;
    external_session_id?: string | null;
  },
) {
  conn.raw
    .prepare(
      `INSERT INTO goal_nodes (
        id,
        parent_id,
        type,
        title,
        objective,
        status,
        dependency_ids,
        execution_base_url,
        external_session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.parent_id,
      input.type,
      input.title,
      input.objective,
      deriveInitialStatus(conn, input.status, input.dependency_ids),
      serializeDependencyIds(input.dependency_ids),
      input.execution_base_url ?? null,
      input.external_session_id ?? null,
    );

  const row = getRowById(conn, input.id);
  if (!row) {
    throw asNotFoundError(`goal node ${input.id} not found`);
  }

  return mapGoalNode(row);
}

export function createGoalsService(conn: GoalsServiceConnection) {
  return {
    createRootGoal(input: CreateRootGoalInput) {
      return withImmediateTransaction(conn, () => {
        const id = input.id ?? crypto.randomUUID();
        const status = input.status ?? "todo";

        assertGoalStatus(status);
        assertGoalNodeDoesNotUseSessionFields({});

        if ((input.dependency_ids ?? []).length > 0) {
          throw asValidationError("root goals cannot declare dependencies");
        }

        return insertGoalNode(conn, {
          id,
          parent_id: null,
          type: "goal",
          title: input.title,
          objective: input.objective,
          status,
          dependency_ids: [],
        });
      });
    },

    createGoalNode(input: CreateGoalNodeInput) {
      return withImmediateTransaction(conn, () => {
        const id = input.id ?? crypto.randomUUID();
        const status = input.status ?? "todo";
        const parent_id = input.parent_id ?? null;
        const dependency_ids = input.dependency_ids ?? [];

        assertGoalStatus(status);
        assertGoalNodeDoesNotUseSessionFields(input);

        if (parent_id === null) {
          if (dependency_ids.length > 0) {
            throw asValidationError("root goals cannot declare dependencies");
          }

          return insertGoalNode(conn, {
            id,
            parent_id: null,
            type: "goal",
            title: input.title,
            objective: input.objective,
            status,
            dependency_ids: [],
          });
        }

        assertGoalParent(conn, parent_id);
        makeRoomIfNeeded(conn, parent_id, input);
        assertDependencies(conn, { id, parent_id, dependency_ids });

        return insertGoalNode(conn, {
          id,
          parent_id,
          type: "goal",
          title: input.title,
          objective: input.objective,
          status,
          dependency_ids,
        });
      });
    },

    createSessionNode(input: CreateActivationSessionNodeInput) {
      return withImmediateTransaction(conn, () => {
        const id = input.id ?? crypto.randomUUID();
        const status = input.status ?? "todo";
        const dependency_ids = input.dependency_ids ?? [];

        assertSessionLocalStatus(status);
        assertSessionFields(input);
        assertGoalParent(conn, input.parent_id);
        makeRoomIfNeeded(conn, input.parent_id, input);
        assertDependencies(conn, { id, parent_id: input.parent_id, dependency_ids });

        return insertGoalNode(conn, {
          id,
          parent_id: input.parent_id,
          type: "session",
          title: input.title,
          objective: input.objective,
          status,
          dependency_ids,
          execution_base_url: input.execution_base_url,
          external_session_id: input.external_session_id,
        });
      });
    },

    listTree() {
      return listRows(conn).map(mapGoalNode);
    },

    getNode(id: string) {
      const row = getRowById(conn, id);
      return row ? mapGoalNode(row) : null;
    },

    updateNodeStatus(id: string, status: GoalStatus | SessionLocalStatus) {
      return withImmediateTransaction(conn, () => {
        const row = getRowById(conn, id);
        if (!row) {
          throw asNotFoundError(`goal node ${id} not found`);
        }

        if (row.type === "goal") {
          assertGoalStatus(status);
        } else {
          assertSessionLocalStatus(status);
        }

        const dependencyIds = deserializeDependencyIds(row.dependency_ids);
        const satisfied = dependenciesSatisfied(conn, dependencyIds);

        if (status === "blocked" && satisfied) {
          throw asValidationError("blocked status requires unmet dependencies");
        }

        if (status === "done" && !satisfied) {
          throw asValidationError(
            row.type === "goal"
              ? "goal dependencies must be done before completion"
              : "dependencies must be done before completion",
          );
        }

        return persistStatus(conn, row, status);
      });
    },

    updateNodeDependencies(input: { id: string; dependency_ids: string[] }) {
      return withImmediateTransaction(conn, () => {
        const row = getRowById(conn, input.id);
        if (!row) {
          throw asNotFoundError(`goal node ${input.id} not found`);
        }

        if (row.parent_id === null && input.dependency_ids.length > 0) {
          throw asValidationError("root goals cannot declare dependencies");
        }

        assertDependencies(conn, {
          id: row.id,
          parent_id: row.parent_id,
          dependency_ids: input.dependency_ids,
        });

        conn.raw
          .prepare("UPDATE goal_nodes SET dependency_ids = ? WHERE id = ?")
          .run(serializeDependencyIds(input.dependency_ids), row.id);

        const updatedRow = getRowById(conn, row.id);
        if (!updatedRow) {
          throw asNotFoundError(`goal node ${row.id} not found`);
        }

        const nextStatus = recomputeStoredStatus(conn, updatedRow);
        conn.raw.prepare("UPDATE goal_nodes SET status = ? WHERE id = ?").run(nextStatus, row.id);
        propagateDependentStatuses(conn, row.id);

        const refreshedRow = getRowById(conn, row.id);
        if (!refreshedRow) {
          throw asNotFoundError(`goal node ${row.id} not found`);
        }

        return mapGoalNode(refreshedRow);
      });
    },
  };
}
