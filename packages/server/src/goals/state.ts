import { EXECUTION_SESSION_STATUSES } from "./constants.js";
import type {
  ExecutionSessionStatus,
  GoalNode,
  GoalNodeGoal,
  GoalNodeStatus,
  GoalNodeSession,
  GoalStatus,
  SessionStatus,
} from "./types.js";

function assertExecutionSessionStatus(status: string): asserts status is ExecutionSessionStatus {
  if (!(EXECUTION_SESSION_STATUSES as readonly string[]).includes(status)) {
    throw new Error("unknown execution session status");
  }
}

export function recomputeGoalNodeStatus(
  node: GoalNodeGoal,
  dependenciesSatisfied: boolean,
): GoalStatus {
  if (node.status === "cancelled") {
    return "cancelled";
  }

  if (!dependenciesSatisfied) {
    return "blocked";
  }

  if (node.status === "done") {
    return "done";
  }

  return "todo";
}

export function recomputeSessionNodeStatus(
  node: GoalNodeSession,
  executionStatus: ExecutionSessionStatus,
  dependenciesSatisfied: boolean,
): SessionStatus {
  assertExecutionSessionStatus(executionStatus);

  if (node.status === "cancelled") {
    return "cancelled";
  }

  if (executionStatus === "cancelled") {
    return "cancelled";
  }

  if (node.status === "done") {
    return "done";
  }

  if (!dependenciesSatisfied) {
    return "blocked";
  }

  if (executionStatus === "running") {
    return "running";
  }

  return "todo";
}

export function recomputeNodeStatus(
  node: GoalNode,
  options: {
    dependenciesSatisfied: boolean;
    executionStatus?: ExecutionSessionStatus;
  },
): GoalNodeStatus {
  if (node.type === "goal") {
    return recomputeGoalNodeStatus(node, options.dependenciesSatisfied);
  }

  if (!options.executionStatus) {
    throw new Error("execution status is required for session nodes");
  }

  return recomputeSessionNodeStatus(node, options.executionStatus, options.dependenciesSatisfied);
}
