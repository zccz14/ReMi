import type { GoalNode, GoalNodeGoal, GoalNodeSession } from "./types.js";

export interface GreedyPathSelection {
  path: GoalNode[];
  terminal: GoalNodeSession;
}

export interface GreedyPathChooser {
  chooseChild(candidates: GoalNode[]): GoalNode | string | null;
}

function isTraversable(node: GoalNode) {
  return node.status === "todo";
}

function isAppendableSession(node: GoalNode): node is GoalNodeSession {
  return node.type === "session" && node.status === "todo";
}

function indexChildren(nodes: GoalNode[]) {
  const childrenByParent = new Map<string | null, GoalNode[]>();

  for (const node of nodes) {
    const siblings = childrenByParent.get(node.parent_id) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parent_id, siblings);
  }

  return childrenByParent;
}

function chooseCandidate(candidates: GoalNode[], chooser: GreedyPathChooser) {
  const selected = chooser.chooseChild(candidates);

  if (selected === null) {
    return null;
  }

  const selectedId = typeof selected === "string" ? selected : selected.id;
  const match = candidates.find((candidate) => candidate.id === selectedId);

  if (!match) {
    throw new Error("chooser must return one of the candidate nodes");
  }

  return match;
}

function hasAppendableSession(
  node: GoalNode,
  childrenByParent: Map<string | null, GoalNode[]>,
  memo: Map<string, boolean>,
): boolean {
  const cached = memo.get(node.id);
  if (cached !== undefined) {
    return cached;
  }

  if (!isTraversable(node)) {
    memo.set(node.id, false);
    return false;
  }

  if (isAppendableSession(node)) {
    memo.set(node.id, true);
    return true;
  }

  const result = (childrenByParent.get(node.id) ?? []).some((child) =>
    hasAppendableSession(child, childrenByParent, memo),
  );
  memo.set(node.id, result);
  return result;
}

function eligibleChildren(
  node: GoalNodeGoal,
  childrenByParent: Map<string | null, GoalNode[]>,
  memo: Map<string, boolean>,
) {
  return (childrenByParent.get(node.id) ?? []).filter((child) =>
    hasAppendableSession(child, childrenByParent, memo),
  );
}

export function selectGreedyGoalPath(
  nodes: GoalNode[],
  chooser: GreedyPathChooser,
): GreedyPathSelection | null {
  const childrenByParent = indexChildren(nodes);
  const memo = new Map<string, boolean>();
  const roots = (childrenByParent.get(null) ?? []).filter((node) =>
    hasAppendableSession(node, childrenByParent, memo),
  );

  if (roots.length === 0) {
    return null;
  }

  let current = roots.length === 1 ? roots[0] : chooseCandidate(roots, chooser);
  if (!current) {
    return null;
  }

  const path: GoalNode[] = [current];

  while (current.type === "goal") {
    const candidates = eligibleChildren(current, childrenByParent, memo);
    if (candidates.length === 0) {
      return null;
    }

    const next = chooseCandidate(candidates, chooser);
    if (!next) {
      return null;
    }

    path.push(next);
    current = next;
  }

  return {
    path,
    terminal: current,
  };
}
