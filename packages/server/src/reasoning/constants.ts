import { RECALL_FULL_INJECTION_THRESHOLD } from "../recall/constants.js";

export const REASONING_ANCHOR_SELECTION_STRATEGIES = {
  FULL_INJECTION: "full-injection",
  BATCH_RECALL: "batch-recall",
} as const;

export const REASONING_FULL_INJECTION_THRESHOLD = RECALL_FULL_INJECTION_THRESHOLD;

export type ReasoningAnchorSelectionStrategy =
  (typeof REASONING_ANCHOR_SELECTION_STRATEGIES)[keyof typeof REASONING_ANCHOR_SELECTION_STRATEGIES];

export function mapRecallRuntimeStrategyToReasoningStrategy(
  strategy: "full-injection" | "recall-loop",
): ReasoningAnchorSelectionStrategy {
  return strategy === "full-injection"
    ? REASONING_ANCHOR_SELECTION_STRATEGIES.FULL_INJECTION
    : REASONING_ANCHOR_SELECTION_STRATEGIES.BATCH_RECALL;
}
