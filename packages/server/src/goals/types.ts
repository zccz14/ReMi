import type {
  EXECUTION_SESSION_STATUSES,
  GOAL_NODE_STATUSES,
  GOAL_NODE_TYPES,
  GOAL_STATUS_VALUES,
  SESSION_STATUS_VALUES,
} from "./constants.js";

export type GoalNodeType = (typeof GOAL_NODE_TYPES)[number];

export type GoalNodeStatus = (typeof GOAL_NODE_STATUSES)[number];

export type GoalStatus = (typeof GOAL_STATUS_VALUES)[number];

export type SessionStatus = (typeof SESSION_STATUS_VALUES)[number];

export type SessionLocalStatus = Exclude<SessionStatus, "running">;

export type ExecutionSessionStatus = (typeof EXECUTION_SESSION_STATUSES)[number];

export interface GoalNodeBase {
  id: string;
  parent_id: string | null;
  title: string;
  objective: string;
  dependency_ids: string[];
}

export interface GoalNodeGoal extends GoalNodeBase {
  type: "goal";
  status: GoalStatus;
  execution_base_url: null;
  external_session_id: null;
}

export interface GoalNodeSession extends GoalNodeBase {
  type: "session";
  status: SessionStatus;
  execution_base_url: string;
  external_session_id: string;
}

export type GoalNode = GoalNodeGoal | GoalNodeSession;

export interface CreateRootGoalInput {
  id?: string;
  title: string;
  objective: string;
  status: GoalStatus;
  dependency_ids?: string[];
}

export interface CreateChildGoalInput extends CreateRootGoalInput {
  parent_id: string;
}

export interface CreateSessionNodeInput {
  id?: string;
  parent_id: string;
  title: string;
  objective: string;
  status: SessionLocalStatus;
  dependency_ids?: string[];
  execution_base_url: string;
  external_session_id: string;
}
