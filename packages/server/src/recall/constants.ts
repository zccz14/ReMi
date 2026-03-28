export const RECALL_FULL_INJECTION_THRESHOLD = 20;

export const RECALL_STOP_REASONS = {
  SUFFICIENT: "sufficient",
  NO_NEW_ANCHORS: "no-new-anchors",
  NO_MISSING_REDUCED: "no-missing-reduced",
  EMPTY_NEXT_QUERY: "empty-next-query",
  PARSE_FAILURE: "parse-failure",
  MAX_ROUNDS: "max-rounds",
} as const;

export const RECALL_MISSING_KEYS = [
  "identity-unknown",
  "style-unknown",
  "visitor-relationship",
  "visitor-boundary",
  "domain-fact-missing",
  "domain-preference-missing",
  "recent-position",
  "time-validity-uncertain",
  "unassessed-required-goal",
  "other",
] as const;

export type RecallStopReason = (typeof RECALL_STOP_REASONS)[keyof typeof RECALL_STOP_REASONS];
export type RecallMissingKey = (typeof RECALL_MISSING_KEYS)[number];
