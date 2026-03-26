import { describe, expect, it } from "vitest";
import { selectGreedyGoalPath } from "../packages/server/src/goals/path-selection";

describe("greedy goal path selection", () => {
  it("traverses from root to leaf over mixed goal and session nodes", () => {
    const selection = selectGreedyGoalPath(
      [
        {
          id: "root",
          parent_id: null,
          type: "goal",
          title: "Root",
          objective: "Root objective",
          status: "todo",
          dependency_ids: [],
          execution_base_url: null,
          external_session_id: null,
        },
        {
          id: "branch-a",
          parent_id: "root",
          type: "goal",
          title: "Branch A",
          objective: "Chosen branch",
          status: "todo",
          dependency_ids: [],
          execution_base_url: null,
          external_session_id: null,
        },
        {
          id: "branch-b",
          parent_id: "root",
          type: "goal",
          title: "Branch B",
          objective: "Other branch",
          status: "todo",
          dependency_ids: [],
          execution_base_url: null,
          external_session_id: null,
        },
        {
          id: "session-a",
          parent_id: "branch-a",
          type: "session",
          title: "Session A",
          objective: "Append here",
          status: "todo",
          dependency_ids: [],
          execution_base_url: "https://exec.example.test",
          external_session_id: "sess-a",
        },
        {
          id: "session-b",
          parent_id: "branch-b",
          type: "session",
          title: "Session B",
          objective: "Not chosen",
          status: "todo",
          dependency_ids: [],
          execution_base_url: "https://exec.example.test",
          external_session_id: "sess-b",
        },
      ],
      {
        chooseChild(candidates) {
          return candidates[0]?.id === "branch-a" ? "branch-a" : "session-a";
        },
      },
    );

    expect(selection?.path.map((node) => node.id)).toEqual(["root", "branch-a", "session-a"]);
    expect(selection?.terminal.id).toBe("session-a");
  });

  it("skips done, cancelled, blocked, and non-appendable subtrees before value choice", () => {
    const chooserCalls: string[][] = [];

    const selection = selectGreedyGoalPath(
      [
        {
          id: "root",
          parent_id: null,
          type: "goal",
          title: "Root",
          objective: "Root objective",
          status: "todo",
          dependency_ids: [],
          execution_base_url: null,
          external_session_id: null,
        },
        {
          id: "done-goal",
          parent_id: "root",
          type: "goal",
          title: "Done",
          objective: "Finished",
          status: "done",
          dependency_ids: [],
          execution_base_url: null,
          external_session_id: null,
        },
        {
          id: "cancelled-goal",
          parent_id: "root",
          type: "goal",
          title: "Cancelled",
          objective: "Abandoned",
          status: "cancelled",
          dependency_ids: [],
          execution_base_url: null,
          external_session_id: null,
        },
        {
          id: "blocked-goal",
          parent_id: "root",
          type: "goal",
          title: "Blocked",
          objective: "Waits on dependency",
          status: "blocked",
          dependency_ids: ["dep-1"],
          execution_base_url: null,
          external_session_id: null,
        },
        {
          id: "running-subtree",
          parent_id: "root",
          type: "goal",
          title: "Running subtree",
          objective: "Has no appendable session",
          status: "todo",
          dependency_ids: [],
          execution_base_url: null,
          external_session_id: null,
        },
        {
          id: "running-session",
          parent_id: "running-subtree",
          type: "session",
          title: "Running session",
          objective: "Already running",
          status: "running",
          dependency_ids: [],
          execution_base_url: "https://exec.example.test",
          external_session_id: "sess-running",
        },
        {
          id: "appendable-goal",
          parent_id: "root",
          type: "goal",
          title: "Appendable subtree",
          objective: "Contains one appendable session",
          status: "todo",
          dependency_ids: [],
          execution_base_url: null,
          external_session_id: null,
        },
        {
          id: "appendable-session",
          parent_id: "appendable-goal",
          type: "session",
          title: "Appendable session",
          objective: "Can receive input",
          status: "todo",
          dependency_ids: [],
          execution_base_url: "https://exec.example.test",
          external_session_id: "sess-appendable",
        },
      ],
      {
        chooseChild(candidates) {
          chooserCalls.push(candidates.map((candidate) => candidate.id));
          return candidates[0]?.id ?? null;
        },
      },
    );

    expect(chooserCalls).toEqual([["appendable-goal"], ["appendable-session"]]);
    expect(selection?.path.map((node) => node.id)).toEqual([
      "root",
      "appendable-goal",
      "appendable-session",
    ]);
  });

  it("returns null when no root subtree has an appendable session", () => {
    const selection = selectGreedyGoalPath(
      [
        {
          id: "root",
          parent_id: null,
          type: "goal",
          title: "Root",
          objective: "Root objective",
          status: "todo",
          dependency_ids: [],
          execution_base_url: null,
          external_session_id: null,
        },
        {
          id: "blocked-session",
          parent_id: "root",
          type: "session",
          title: "Blocked session",
          objective: "Cannot append",
          status: "blocked",
          dependency_ids: ["dep-1"],
          execution_base_url: "https://exec.example.test",
          external_session_id: "sess-blocked",
        },
      ],
      {
        chooseChild() {
          throw new Error("chooser should not run without candidates");
        },
      },
    );

    expect(selection).toBeNull();
  });
});
