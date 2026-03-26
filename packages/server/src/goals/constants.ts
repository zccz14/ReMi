export const GOAL_NODE_CHILD_LIMIT = 5;

export const GOAL_NODE_TYPES = ["goal", "session"] as const;

export const GOAL_NODE_STATUSES = ["todo", "running", "blocked", "done", "cancelled"] as const;

export const GOAL_STATUS_VALUES = ["todo", "blocked", "done", "cancelled"] as const;

export const SESSION_STATUS_VALUES = ["todo", "running", "blocked", "done", "cancelled"] as const;

export const EXECUTION_SESSION_STATUSES = ["idle", "running", "cancelled"] as const;
