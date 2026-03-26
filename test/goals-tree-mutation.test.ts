import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConnectionManager } from "../packages/server/src/db/connection";
import { createGoalTreeMutator } from "../packages/server/src/goals/tree-mutation";

describe("goal tree activation-time mutation helpers", () => {
  let tmpDir: string;
  let connMgr: ConnectionManager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `remi-goals-tree-mutation-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    connMgr = new ConnectionManager(tmpDir, { embeddingDimensions: 4 });
  });

  afterEach(() => {
    connMgr.closeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates goal and session nodes during activation with shared validation", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const mutator = createGoalTreeMutator(conn);

    const root = mutator.createRootGoal({
      title: "Launch goal tree",
      objective: "Ship owner goal management",
    });

    const child = mutator.createGoalNode({
      parent_id: root.id,
      title: "Plan route work",
      objective: "Break down owner endpoints",
    });

    expect(child.type).toBe("goal");
    expect(child.status).toBe("todo");

    const session = mutator.createSessionNode({
      parent_id: root.id,
      title: "Run execution",
      objective: "Create execution leaf",
      dependency_ids: [child.id],
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-123",
    });

    expect(session.type).toBe("session");
    expect(session.status).toBe("blocked");
    expect(session.execution_base_url).toBe("https://exec.example.test");

    expect(() =>
      mutator.createGoalNode({
        parent_id: root.id,
        title: "Bad goal",
        objective: "Should reject session-only fields",
        execution_base_url: "https://exec.example.test",
        external_session_id: "sess-should-not-exist",
      }),
    ).toThrow("goal nodes cannot include session fields");

    expect(() =>
      mutator.createSessionNode({
        parent_id: root.id,
        title: "Broken session",
        objective: "Missing execution base url",
        external_session_id: "sess-missing-base",
      }),
    ).toThrow("execution_base_url is required");

    expect(() =>
      mutator.createSessionNode({
        parent_id: root.id,
        title: "Broken session",
        objective: "Missing external session id",
        execution_base_url: "https://exec.example.test",
      }),
    ).toThrow("external_session_id is required");
  });

  it("rejects activation-time self dependency, cycles, and cross-tree dependencies", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const mutator = createGoalTreeMutator(conn);

    const root = mutator.createRootGoal({ title: "Root", objective: "Root objective" });
    const otherRoot = mutator.createRootGoal({ title: "Other Root", objective: "Other objective" });
    const parent = mutator.createGoalNode({
      parent_id: root.id,
      title: "Parent",
      objective: "Parent objective",
    });
    const child = mutator.createGoalNode({
      parent_id: parent.id,
      title: "Child",
      objective: "Child objective",
    });
    const otherTreeChild = mutator.createGoalNode({
      parent_id: otherRoot.id,
      title: "Other child",
      objective: "Other child objective",
    });

    expect(() =>
      mutator.createGoalNode({
        id: "self-dep-node",
        parent_id: root.id,
        title: "Self dep",
        objective: "Depends on itself",
        dependency_ids: ["self-dep-node"],
      }),
    ).toThrow("node cannot depend on itself");

    expect(() =>
      mutator.createGoalNode({
        parent_id: child.id,
        title: "Cycle dep",
        objective: "Would create a cycle",
        dependency_ids: [root.id],
      }),
    ).toThrow("dependency would create a cycle");

    expect(() =>
      mutator.createGoalNode({
        parent_id: root.id,
        title: "Cross tree dep",
        objective: "Would point outside the tree",
        dependency_ids: [otherTreeChild.id],
      }),
    ).toThrow("dependency must stay within the same tree");
  });

  it("rejects a sixth child without cancel-or-replace and allows it after room is made", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const mutator = createGoalTreeMutator(conn);

    const root = mutator.createRootGoal({ title: "Root", objective: "Root objective" });
    const children = Array.from({ length: 5 }, (_, index) =>
      mutator.createGoalNode({
        parent_id: root.id,
        title: `Child ${index + 1}`,
        objective: `Objective ${index + 1}`,
      }),
    );

    expect(() =>
      mutator.createGoalNode({
        parent_id: root.id,
        title: "Child 6",
        objective: "Should fail without room",
      }),
    ).toThrow("parent already has maximum children");

    const replacement = mutator.createGoalNode({
      parent_id: root.id,
      title: "Child 6",
      objective: "Should succeed after replace",
      replace_node_id: children[0]?.id,
    });

    expect(replacement.parent_id).toBe(root.id);
    expect(mutator.getNode(children[0]!.id)?.status).toBe("cancelled");

    const fullRoot = mutator.createRootGoal({ title: "Full root", objective: "Separate branch" });
    const fullChildren = Array.from({ length: 5 }, (_, index) =>
      mutator.createGoalNode({
        parent_id: fullRoot.id,
        title: `Full child ${index + 1}`,
        objective: `Full objective ${index + 1}`,
      }),
    );

    const createdAfterCancel = mutator.createSessionNode({
      parent_id: fullRoot.id,
      title: "Session 6",
      objective: "Should succeed after cancel",
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-6",
      cancel_node_id: fullChildren[1]?.id,
    });

    expect(createdAfterCancel.type).toBe("session");
    expect(mutator.getNode(fullChildren[1]!.id)?.status).toBe("cancelled");
  });

  it("recomputes dependency-gated visibility after dependency changes", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const mutator = createGoalTreeMutator(conn);

    const root = mutator.createRootGoal({ title: "Root", objective: "Root objective" });
    const blockedDep = mutator.createGoalNode({
      parent_id: root.id,
      title: "Blocked dep",
      objective: "Not done yet",
    });
    const doneDep = mutator.createGoalNode({
      parent_id: root.id,
      title: "Done dep",
      objective: "Already complete",
      status: "done",
    });
    const child = mutator.createGoalNode({
      parent_id: root.id,
      title: "Child",
      objective: "Switches visibility based on deps",
      dependency_ids: [blockedDep.id],
    });

    expect(mutator.getNode(child.id)?.status).toBe("blocked");

    const updatedChild = mutator.updateNodeDependencies({
      id: child.id,
      dependency_ids: [doneDep.id],
    });

    expect(updatedChild.status).toBe("todo");

    const blockedAgain = mutator.updateNodeDependencies({
      id: child.id,
      dependency_ids: [blockedDep.id],
    });

    expect(blockedAgain.status).toBe("blocked");
  });

  it("rejects dependency rewrites that create a parent-dependency cycle", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const mutator = createGoalTreeMutator(conn);

    const root = mutator.createRootGoal({ title: "Root", objective: "Root objective" });
    const parent = mutator.createGoalNode({
      parent_id: root.id,
      title: "Parent",
      objective: "Parent objective",
    });
    const child = mutator.createGoalNode({
      parent_id: parent.id,
      title: "Child",
      objective: "Child objective",
    });

    expect(() =>
      mutator.updateNodeDependencies({
        id: parent.id,
        dependency_ids: [child.id],
      }),
    ).toThrow("dependency would create a cycle");
  });

  it("keeps done session nodes done when dependency rewrites become unmet", () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const mutator = createGoalTreeMutator(conn);

    const root = mutator.createRootGoal({ title: "Root", objective: "Root objective" });
    const readyDep = mutator.createGoalNode({
      parent_id: root.id,
      title: "Ready dep",
      objective: "Already complete",
      status: "done",
    });
    const blockedDep = mutator.createGoalNode({
      parent_id: root.id,
      title: "Blocked dep",
      objective: "Not done yet",
      status: "todo",
    });
    const session = mutator.createSessionNode({
      parent_id: root.id,
      title: "Session",
      objective: "Executable leaf",
      status: "done",
      dependency_ids: [readyDep.id],
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-done-dependency-rewrite",
    });

    const updatedSession = mutator.updateNodeDependencies({
      id: session.id,
      dependency_ids: [blockedDep.id],
    });

    expect(updatedSession.status).toBe("done");
  });
});
