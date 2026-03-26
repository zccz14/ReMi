import { describe, expect, it } from "vitest";
import {
  recomputeGoalNodeStatus,
  recomputeSessionNodeStatus,
} from "../packages/server/src/goals/state";

describe("goal state recompute", () => {
  it("recomputes goal nodes from local status plus dependency gating", () => {
    expect(
      recomputeGoalNodeStatus(
        {
          id: "goal-cancelled",
          parent_id: null,
          type: "goal",
          title: "Cancelled goal",
          objective: "Stop this branch",
          status: "cancelled",
          dependency_ids: [],
          execution_base_url: null,
          external_session_id: null,
        },
        true,
      ),
    ).toBe("cancelled");

    expect(
      recomputeGoalNodeStatus(
        {
          id: "goal-blocked",
          parent_id: null,
          type: "goal",
          title: "Blocked goal",
          objective: "Wait for prerequisite",
          status: "done",
          dependency_ids: ["dep-1"],
          execution_base_url: null,
          external_session_id: null,
        },
        false,
      ),
    ).toBe("blocked");

    expect(
      recomputeGoalNodeStatus(
        {
          id: "goal-done",
          parent_id: null,
          type: "goal",
          title: "Done goal",
          objective: "Already finished",
          status: "done",
          dependency_ids: [],
          execution_base_url: null,
          external_session_id: null,
        },
        true,
      ),
    ).toBe("done");

    expect(
      recomputeGoalNodeStatus(
        {
          id: "goal-todo",
          parent_id: null,
          type: "goal",
          title: "Todo goal",
          objective: "Can proceed",
          status: "todo",
          dependency_ids: [],
          execution_base_url: null,
          external_session_id: null,
        },
        true,
      ),
    ).toBe("todo");
  });

  it("applies session recompute priority rules", () => {
    const sessionNode = {
      id: "session-node",
      parent_id: "goal-root",
      type: "session" as const,
      title: "Session",
      objective: "Drive execution",
      status: "todo" as const,
      dependency_ids: [],
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-1",
    };

    expect(
      recomputeSessionNodeStatus({ ...sessionNode, status: "cancelled" }, "running", true),
    ).toBe("cancelled");
    expect(recomputeSessionNodeStatus({ ...sessionNode, status: "done" }, "idle", true)).toBe(
      "done",
    );
    expect(recomputeSessionNodeStatus(sessionNode, "running", false)).toBe("blocked");
    expect(recomputeSessionNodeStatus(sessionNode, "running", true)).toBe("running");
    expect(recomputeSessionNodeStatus(sessionNode, "idle", true)).toBe("todo");
    expect(recomputeSessionNodeStatus({ ...sessionNode, status: "done" }, "cancelled", true)).toBe(
      "cancelled",
    );
  });

  it("rejects unknown execution statuses", () => {
    expect(() =>
      recomputeSessionNodeStatus(
        {
          id: "session-node",
          parent_id: "goal-root",
          type: "session",
          title: "Session",
          objective: "Drive execution",
          status: "todo",
          dependency_ids: [],
          execution_base_url: "https://exec.example.test",
          external_session_id: "sess-1",
        },
        "failed" as never,
        true,
      ),
    ).toThrow("unknown execution session status");
  });
});
