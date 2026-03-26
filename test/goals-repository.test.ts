import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConnectionManager } from "../packages/server/src/db/connection";
import {
  GOAL_NODE_CHILD_LIMIT,
  createGoalsRepository,
} from "../packages/server/src/goals/repository";

describe("goal nodes schema", () => {
  let tmpDir: string;
  let connMgr: ConnectionManager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `remi-goals-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    connMgr = new ConnectionManager(tmpDir, { embeddingDimensions: 4 });
  });

  afterEach(() => {
    connMgr.closeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fresh db stores and reads back goal_nodes rows", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const dependency_ids = ["dep-1", "dep-2"];

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
        "goal-root",
        null,
        "goal",
        "Ship MVP",
        "Have a usable first release",
        "todo",
        JSON.stringify(dependency_ids),
        null,
        null,
      );

    const row = conn.raw
      .prepare("SELECT * FROM goal_nodes WHERE id = ?")
      .get("goal-root") as Record<string, unknown>;

    expect(row).toMatchObject({
      id: "goal-root",
      parent_id: null,
      type: "goal",
      title: "Ship MVP",
      objective: "Have a usable first release",
      status: "todo",
      dependency_ids: JSON.stringify(dependency_ids),
      execution_base_url: null,
      external_session_id: null,
    });
  });

  it("fresh db rejects null objective and invalid status", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });

    expect(() =>
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
        .run("goal-null-objective", null, "goal", "Bad Goal", null, "todo", "[]", null, null),
    ).toThrow();

    expect(() =>
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
          "goal-invalid-status",
          null,
          "goal",
          "Bad Status",
          "Still has objective",
          "active",
          "[]",
          null,
          null,
        ),
    ).toThrow();
  });

  it("fresh db rejects invalid goal and session field combinations", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });

    expect(() =>
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
          "goal-with-session-fields",
          null,
          "goal",
          "Bad Goal",
          "Should not keep session fields",
          "todo",
          "[]",
          "https://example.test/session",
          "sess-123",
        ),
    ).toThrow();

    expect(() =>
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
          "goal-running",
          null,
          "goal",
          "Running Goal",
          "Goals cannot run directly",
          "running",
          "[]",
          null,
          null,
        ),
    ).toThrow();

    expect(() =>
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
          "session-missing-fields",
          null,
          "session",
          "Broken Session",
          "Sessions need external bindings",
          "todo",
          "[]",
          null,
          null,
        ),
    ).toThrow();
  });

  it("repository creates and updates goal tree primitives", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const repository = createGoalsRepository(conn);

    const root = repository.createRootGoal({
      title: "Launch ReMi goals",
      objective: "Ship the first goal tree MVP",
      status: "todo",
      dependency_ids: [],
    });

    expect(root.parent_id).toBeNull();
    expect(root.type).toBe("goal");
    expect(root.dependency_ids).toEqual([]);

    const prerequisite = repository.createChildGoal({
      parent_id: root.id,
      title: "Collect context",
      objective: "Gather prerequisite info",
      status: "todo",
      dependency_ids: [],
    });

    const childGoal = repository.createChildGoal({
      parent_id: root.id,
      title: "Prepare scheduler",
      objective: "Get execution planning ready",
      status: "todo",
      dependency_ids: [prerequisite.id],
    });

    expect(childGoal.status).toBe("blocked");

    const sessionNode = repository.createSessionNode({
      parent_id: root.id,
      title: "Open execution session",
      objective: "Create the first execution leaf",
      status: "todo",
      dependency_ids: [childGoal.id],
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-123",
    });

    expect(sessionNode.type).toBe("session");
    expect(sessionNode.status).toBe("blocked");
    expect(sessionNode.execution_base_url).toBe("https://exec.example.test");
    expect(sessionNode.external_session_id).toBe("sess-123");
    expect(sessionNode.dependency_ids).toEqual([childGoal.id]);

    expect(repository.listChildren(root.id).map((node) => node.id)).toEqual([
      prerequisite.id,
      childGoal.id,
      sessionNode.id,
    ]);

    expect(() => repository.updateGoalLocalStatus(childGoal.id, "done")).toThrow(
      "goal dependencies must be done before completion",
    );

    repository.updateGoalLocalStatus(prerequisite.id, "done");

    const updated = repository.updateGoalLocalStatus(childGoal.id, "done");
    expect(updated?.status).toBe("done");

    const storedChild = conn.raw
      .prepare("SELECT * FROM goal_nodes WHERE id = ?")
      .get(childGoal.id) as Record<string, unknown>;
    expect(storedChild.dependency_ids).toBe(JSON.stringify([prerequisite.id]));

    const unblockedSession = conn.raw
      .prepare("SELECT status FROM goal_nodes WHERE id = ?")
      .get(sessionNode.id) as { status: string };
    expect(unblockedSession.status).toBe("todo");
  });

  it("repository rejects dependency ids on root goals", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const repository = createGoalsRepository(conn);

    expect(() =>
      repository.createRootGoal({
        title: "Launch ReMi goals",
        objective: "Ship the first goal tree MVP",
        status: "todo",
        dependency_ids: ["some-node"],
      }),
    ).toThrow("root goals cannot declare dependencies");

    expect(() =>
      repository.createRootGoal({
        title: "Blocked root",
        objective: "Should not be manually blocked",
        status: "blocked",
      }),
    ).toThrow("blocked status requires unmet dependencies");
  });

  it("exports a single child limit constant", () => {
    expect(GOAL_NODE_CHILD_LIMIT).toBe(5);
  });

  it("repository requires session-only fields for session nodes", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const repository = createGoalsRepository(conn);
    const root = repository.createRootGoal({
      title: "Launch ReMi goals",
      objective: "Ship the first goal tree MVP",
      status: "todo",
    });

    expect(() =>
      // @ts-expect-error intentional invalid session input for runtime guard coverage
      repository.createSessionNode({
        parent_id: root.id,
        title: "Open execution session",
        objective: "Create the first execution leaf",
        status: "todo",
        dependency_ids: [],
        external_session_id: "sess-123",
      }),
    ).toThrow("execution_base_url is required");

    expect(() =>
      // @ts-expect-error intentional invalid session input for runtime guard coverage
      repository.createSessionNode({
        parent_id: root.id,
        title: "Open execution session",
        objective: "Create the first execution leaf",
        status: "todo",
        dependency_ids: [],
        execution_base_url: "https://exec.example.test",
      }),
    ).toThrow("external_session_id is required");
  });

  it("repository rejects missing parent or session parent for child creation", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const repository = createGoalsRepository(conn);
    const root = repository.createRootGoal({
      title: "Root",
      objective: "Root objective",
      status: "todo",
    });
    const session = repository.createSessionNode({
      parent_id: root.id,
      title: "Leaf session",
      objective: "Executable leaf",
      status: "todo",
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-parent-check",
    });

    expect(() =>
      repository.createChildGoal({
        parent_id: "missing-parent",
        title: "Orphan child",
        objective: "Should fail",
        status: "todo",
      }),
    ).toThrow("parent goal does not exist");

    expect(() =>
      repository.createSessionNode({
        parent_id: session.id,
        title: "Nested session",
        objective: "Should fail",
        status: "todo",
        execution_base_url: "https://exec.example.test",
        external_session_id: "sess-nested",
      }),
    ).toThrow("parent node must be a goal");
  });

  it("repository rejects creating more than five children under one parent", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const repository = createGoalsRepository(conn);
    const root = repository.createRootGoal({
      title: "Launch ReMi goals",
      objective: "Ship the first goal tree MVP",
      status: "todo",
    });

    for (let index = 0; index < GOAL_NODE_CHILD_LIMIT; index += 1) {
      repository.createChildGoal({
        parent_id: root.id,
        title: `Child ${index + 1}`,
        objective: `Objective ${index + 1}`,
        status: "todo",
      });
    }

    expect(() =>
      repository.createSessionNode({
        parent_id: root.id,
        title: "Overflow session",
        objective: "Should be rejected at limit",
        status: "todo",
        execution_base_url: "https://exec.example.test",
        external_session_id: "sess-overflow",
      }),
    ).toThrow("parent already has maximum children");
  });

  it("repository validates dependency ids", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const repository = createGoalsRepository(conn);
    const root = repository.createRootGoal({
      title: "Root",
      objective: "Root objective",
      status: "todo",
    });
    const siblingRoot = repository.createRootGoal({
      title: "Other Root",
      objective: "Separate tree",
      status: "todo",
    });
    const otherTreeChild = repository.createChildGoal({
      parent_id: siblingRoot.id,
      title: "Other Tree Child",
      objective: "Separate child",
      status: "todo",
    });
    const parent = repository.createChildGoal({
      parent_id: root.id,
      title: "Parent",
      objective: "Parent objective",
      status: "todo",
    });
    const child = repository.createChildGoal({
      parent_id: parent.id,
      title: "Child",
      objective: "Child objective",
      status: "todo",
    });

    expect(() =>
      repository.createChildGoal({
        parent_id: root.id,
        title: "Missing dep",
        objective: "Depends on absent node",
        status: "todo",
        dependency_ids: ["missing-node"],
      }),
    ).toThrow("dependency does not exist");

    expect(() =>
      repository.createChildGoal({
        id: "self-dep-node",
        parent_id: root.id,
        title: "Self dep",
        objective: "Depends on itself",
        status: "todo",
        dependency_ids: ["self-dep-node"],
      }),
    ).toThrow("node cannot depend on itself");

    expect(() =>
      repository.createChildGoal({
        parent_id: root.id,
        title: "Cross tree dep",
        objective: "Depends on other tree",
        status: "todo",
        dependency_ids: [otherTreeChild.id],
      }),
    ).toThrow("dependency must stay within the same tree");

    expect(() =>
      repository.createChildGoal({
        parent_id: child.id,
        title: "Cycle dep",
        objective: "Would create a cycle",
        status: "todo",
        dependency_ids: [root.id],
      }),
    ).toThrow("dependency would create a cycle");

    expect(() =>
      repository.createChildGoal({
        parent_id: root.id,
        title: "Done too early",
        objective: "Cannot be completed before deps resolve",
        status: "done",
        dependency_ids: [parent.id],
      }),
    ).toThrow("dependencies must be done before completion");
  });

  it("repository blocks session running on create and generic update", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const repository = createGoalsRepository(conn);
    const root = repository.createRootGoal({
      title: "Launch ReMi goals",
      objective: "Ship the first goal tree MVP",
      status: "todo",
    });

    const session = repository.createSessionNode({
      parent_id: root.id,
      title: "Queued session",
      objective: "Wait for external runtime",
      status: "todo",
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-queued",
    });

    expect(() =>
      repository.createSessionNode({
        parent_id: root.id,
        title: "Running session",
        objective: "Should not be creatable as running",
        // @ts-expect-error intentional invalid session status for runtime guard coverage
        status: "running",
        execution_base_url: "https://exec.example.test",
        external_session_id: "sess-running",
      }),
    ).toThrow("session nodes cannot use running status here");

    expect(() =>
      // @ts-expect-error intentional invalid session status for runtime guard coverage
      repository.updateSessionLocalStatus(session.id, "running"),
    ).toThrow("session nodes cannot use running status here");
  });

  it("repository separates local session updates from refresh recompute", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const repository = createGoalsRepository(conn);
    const root = repository.createRootGoal({
      title: "Launch ReMi goals",
      objective: "Ship the first goal tree MVP",
      status: "todo",
    });
    const prerequisite = repository.createChildGoal({
      parent_id: root.id,
      title: "Collect context",
      objective: "Gather prerequisite info",
      status: "todo",
    });
    const session = repository.createSessionNode({
      parent_id: root.id,
      title: "Queued session",
      objective: "Wait for external runtime",
      status: "todo",
      dependency_ids: [prerequisite.id],
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-separated-updates",
    });

    expect(() => repository.updateGoalLocalStatus(session.id, "done")).toThrow(
      "goal local update requires a goal node",
    );
    expect(() => repository.updateSessionLocalStatus(root.id, "done")).toThrow(
      "session local update requires a session node",
    );

    expect(repository.updateSessionLocalStatus(session.id, "blocked")?.status).toBe("blocked");

    repository.updateGoalLocalStatus(prerequisite.id, "done");

    expect(repository.updateSessionLocalStatus(session.id, "todo")?.status).toBe("todo");
    expect(repository.applySessionRefreshStatus(session.id, "running")?.status).toBe("running");
    expect(repository.updateSessionLocalStatus(session.id, "done")?.status).toBe("done");
    expect(repository.applySessionRefreshStatus(session.id, "idle")?.status).toBe("done");
  });

  it("repository applySessionRefreshStatus accepts execution statuses and keeps unmet dependencies blocked", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const repository = createGoalsRepository(conn);
    const root = repository.createRootGoal({
      title: "Launch ReMi goals",
      objective: "Ship the first goal tree MVP",
      status: "todo",
    });
    const prerequisite = repository.createChildGoal({
      parent_id: root.id,
      title: "Collect context",
      objective: "Gather prerequisite info",
      status: "todo",
    });
    const session = repository.createSessionNode({
      parent_id: root.id,
      title: "Queued session",
      objective: "Wait for external runtime",
      status: "todo",
      dependency_ids: [prerequisite.id],
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-queued",
    });

    const blockedRefresh = repository.applySessionRefreshStatus(session.id, "running");
    expect(blockedRefresh?.status).toBe("blocked");

    repository.updateGoalLocalStatus(prerequisite.id, "done");

    const runningRefresh = repository.applySessionRefreshStatus(session.id, "running");
    expect(runningRefresh?.status).toBe("running");

    const idleRefresh = repository.applySessionRefreshStatus(session.id, "idle");
    expect(idleRefresh?.status).toBe("todo");

    const cancelledRefresh = repository.applySessionRefreshStatus(session.id, "cancelled");
    expect(cancelledRefresh?.status).toBe("cancelled");
  });

  it("repository unblocks dependent goals when prerequisites become done", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const repository = createGoalsRepository(conn);
    const root = repository.createRootGoal({
      title: "Root",
      objective: "Root objective",
      status: "todo",
    });
    const prerequisite = repository.createChildGoal({
      parent_id: root.id,
      title: "Prerequisite",
      objective: "Finish this first",
      status: "todo",
    });
    const dependent = repository.createChildGoal({
      parent_id: root.id,
      title: "Dependent",
      objective: "Blocked until prerequisite is done",
      status: "todo",
      dependency_ids: [prerequisite.id],
    });

    expect(dependent.status).toBe("blocked");

    repository.updateGoalLocalStatus(prerequisite.id, "done");

    const refreshed = conn.raw
      .prepare("SELECT status FROM goal_nodes WHERE id = ?")
      .get(dependent.id) as { status: string };
    expect(refreshed.status).toBe("todo");
  });

  it("repository re-blocks completed goal dependents when prerequisites regress", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const repository = createGoalsRepository(conn);
    const root = repository.createRootGoal({
      title: "Root",
      objective: "Root objective",
      status: "todo",
    });
    const prerequisite = repository.createChildGoal({
      parent_id: root.id,
      title: "Prerequisite",
      objective: "Finish this first",
      status: "todo",
    });
    const dependent = repository.createChildGoal({
      parent_id: root.id,
      title: "Dependent",
      objective: "Only valid while prerequisite is done",
      status: "todo",
      dependency_ids: [prerequisite.id],
    });

    repository.updateGoalLocalStatus(prerequisite.id, "done");
    repository.updateGoalLocalStatus(dependent.id, "done");
    repository.updateGoalLocalStatus(prerequisite.id, "cancelled");

    const refreshed = conn.raw
      .prepare("SELECT status FROM goal_nodes WHERE id = ?")
      .get(dependent.id) as { status: string };
    expect(refreshed.status).toBe("blocked");
  });

  it("repository reports invalid dependency json with a repository error", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const repository = createGoalsRepository(conn);
    const root = repository.createRootGoal({
      id: "root-node",
      title: "Root",
      objective: "Root objective",
      status: "todo",
    });

    conn.raw.prepare("UPDATE goal_nodes SET dependency_ids = ? WHERE id = ?").run("[1,2]", root.id);

    expect(() => repository.listChildren(root.id)).not.toThrow();
    expect(() => repository.updateGoalLocalStatus(root.id, "done")).toThrow(
      `invalid dependency_ids for goal node ${root.id}`,
    );
  });

  it("repository reports invalid dependency json during session local updates", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const repository = createGoalsRepository(conn);
    const root = repository.createRootGoal({
      title: "Root",
      objective: "Root objective",
      status: "todo",
    });
    const session = repository.createSessionNode({
      id: "session-node",
      parent_id: root.id,
      title: "Session",
      objective: "Session objective",
      status: "todo",
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-invalid-deps",
    });

    conn.raw
      .prepare("UPDATE goal_nodes SET dependency_ids = ? WHERE id = ?")
      .run("[1,2]", session.id);

    expect(() => repository.updateSessionLocalStatus(session.id, "done")).toThrow(
      `invalid dependency_ids for goal node ${session.id}`,
    );
  });

  it("repository rejects unknown execution statuses during refresh", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const repository = createGoalsRepository(conn);
    const root = repository.createRootGoal({
      title: "Launch ReMi goals",
      objective: "Ship the first goal tree MVP",
      status: "todo",
    });
    const session = repository.createSessionNode({
      parent_id: root.id,
      title: "Queued session",
      objective: "Wait for external runtime",
      status: "todo",
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-queued",
    });

    expect(() =>
      // @ts-expect-error intentional invalid execution status for runtime guard coverage
      repository.applySessionRefreshStatus(session.id, "failed"),
    ).toThrow("unknown execution session status");
  });

  it("repository keeps cancelled sessions cancelled across refresh", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const repository = createGoalsRepository(conn);
    const root = repository.createRootGoal({
      title: "Launch ReMi goals",
      objective: "Ship the first goal tree MVP",
      status: "todo",
    });
    const session = repository.createSessionNode({
      parent_id: root.id,
      title: "Queued session",
      objective: "Wait for external runtime",
      status: "todo",
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-cancelled",
    });

    repository.updateSessionLocalStatus(session.id, "cancelled");

    expect(repository.applySessionRefreshStatus(session.id, "idle")?.status).toBe("cancelled");
    expect(repository.applySessionRefreshStatus(session.id, "running")?.status).toBe("cancelled");
  });

  it("repository refresh keeps done sessions done when dependencies regress", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const repository = createGoalsRepository(conn);
    const root = repository.createRootGoal({
      title: "Launch ReMi goals",
      objective: "Ship the first goal tree MVP",
      status: "todo",
    });
    const prerequisite = repository.createChildGoal({
      parent_id: root.id,
      title: "Prerequisite",
      objective: "Complete this first",
      status: "todo",
    });
    const session = repository.createSessionNode({
      parent_id: root.id,
      title: "Queued session",
      objective: "Wait for external runtime",
      status: "todo",
      dependency_ids: [prerequisite.id],
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-done-precedence",
    });

    repository.updateGoalLocalStatus(prerequisite.id, "done");
    repository.updateSessionLocalStatus(session.id, "done");
    repository.updateGoalLocalStatus(prerequisite.id, "cancelled");

    expect(repository.applySessionRefreshStatus(session.id, "idle")?.status).toBe("done");
  });

  it("repository refresh lets execution cancelled override local done for sessions", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const repository = createGoalsRepository(conn);
    const root = repository.createRootGoal({
      title: "Launch ReMi goals",
      objective: "Ship the first goal tree MVP",
      status: "todo",
    });
    const session = repository.createSessionNode({
      parent_id: root.id,
      title: "Queued session",
      objective: "Wait for external runtime",
      status: "todo",
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-cancelled-precedence",
    });

    repository.updateSessionLocalStatus(session.id, "done");

    expect(repository.applySessionRefreshStatus(session.id, "cancelled")?.status).toBe("cancelled");
  });

  it("repository rejects running status for goal nodes", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const repository = createGoalsRepository(conn);

    expect(() =>
      repository.createRootGoal({
        title: "Launch ReMi goals",
        objective: "Ship the first goal tree MVP",
        // @ts-expect-error intentional invalid goal status for runtime guard coverage
        status: "running",
      }),
    ).toThrow("goal nodes cannot use running status");
  });

  it("repository updateStatus rejects moving goal nodes to running", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const repository = createGoalsRepository(conn);
    const goal = repository.createRootGoal({
      title: "Launch ReMi goals",
      objective: "Ship the first goal tree MVP",
      status: "todo",
    });

    expect(() =>
      // @ts-expect-error intentional invalid goal status for runtime guard coverage
      repository.updateGoalLocalStatus(goal.id, "running"),
    ).toThrow("goal nodes cannot use running status");

    expect(() => repository.updateGoalLocalStatus(goal.id, "blocked")).toThrow(
      "blocked status requires unmet dependencies",
    );
  });
});
