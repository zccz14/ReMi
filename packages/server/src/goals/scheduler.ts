import { selectGreedyGoalPath, type GreedyPathChooser } from "./path-selection.js";
import { recomputeNodeStatus } from "./state.js";
import { GoalServiceError, createGoalsService, type CreateGoalNodeInput } from "./service.js";
import type { ExecutionSessionStatus, GoalNode, GoalNodeStatus } from "./types.js";

type GoalsService = ReturnType<typeof createGoalsService>;

interface ExecutionStatusItem {
  sessionId: string;
  status: ExecutionSessionStatus;
  updatedAt: number;
}

interface SchedulerExecutionClient {
  getSessionStatuses(sessionIds: string[]): Promise<ExecutionStatusItem[]>;
  createSession(input: {
    title: string;
    objective: string;
    initialContext: string;
    metadata: {
      remi_node_id: string;
      user_identity_pubkey: string;
    };
  }): Promise<{ sessionId: string; status: ExecutionSessionStatus }>;
  appendSessionMessage(
    sessionId: string,
    content: string,
  ): Promise<{ sessionId: string; accepted: boolean; status: ExecutionSessionStatus }>;
}

export interface SchedulerExecutionClientFactory {
  getClient(baseUrl: string): SchedulerExecutionClient;
}

type SchedulerMutation =
  | { type: "create_goal"; input: CreateGoalNodeInput }
  | { type: "cancel_node"; nodeId: string }
  | { type: "update_dependencies"; input: { id: string; dependency_ids: string[] } };

type SchedulerAction =
  | { type: "noop" }
  | { type: "append_session"; sessionNodeId: string; content: string }
  | {
      type: "create_session";
      input: {
        id?: string;
        parent_id: string;
        title: string;
        objective: string;
        dependency_ids?: string[];
        execution_base_url: string;
        initial_context: string;
      };
    };

export interface GoalSchedulerDecision {
  mutations?: SchedulerMutation[];
  action: SchedulerAction;
}

export interface GoalSchedulerRunResult {
  refreshedNodes: number;
  action: SchedulerAction["type"];
  externalWrites: number;
}

export interface CreateGoalSchedulerOptions {
  userIdentityPubkey: string;
  service: GoalsService;
  chooser: GreedyPathChooser;
  executionClientFactory: SchedulerExecutionClientFactory;
  decideActivation(input: {
    nodes: GoalNode[];
    selection: ReturnType<typeof selectGreedyGoalPath>;
  }): GoalSchedulerDecision | Promise<GoalSchedulerDecision>;
}

export function buildDefaultSchedulerDecision(input: {
  nodes: GoalNode[];
  selection: ReturnType<typeof selectGreedyGoalPath>;
}): GoalSchedulerDecision {
  if (input.selection) {
    return {
      action: {
        type: "append_session",
        sessionNodeId: input.selection.terminal.id,
        content: `Continue advancing this goal path: ${input.selection.path
          .map((node) => node.title)
          .join(" -> ")}`,
      },
    };
  }

  return { action: { type: "noop" } };
}

function computeStatuses(
  nodes: GoalNode[],
  executionStatuses: Map<string, ExecutionSessionStatus>,
): Array<{ id: string; status: GoalNodeStatus }> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const cache = new Map<string, GoalNodeStatus>();

  const computeNode = (nodeId: string): GoalNodeStatus => {
    const cached = cache.get(nodeId);
    if (cached) {
      return cached;
    }

    if (visiting.has(nodeId)) {
      throw new Error(`dependency cycle detected while recomputing ${nodeId}`);
    }

    const node = byId.get(nodeId);
    if (!node) {
      throw new Error(`goal node ${nodeId} not found`);
    }

    visiting.add(nodeId);
    const dependenciesSatisfied = node.dependency_ids.every(
      (dependencyId) => computeNode(dependencyId) === "done",
    );

    const status =
      node.type === "session"
        ? recomputeNodeStatus(node, {
            dependenciesSatisfied,
            executionStatus:
              executionStatuses.get(node.external_session_id) ??
              (node.status === "cancelled"
                ? "cancelled"
                : (() => {
                    throw new Error(
                      `missing execution status for session ${node.external_session_id}`,
                    );
                  })()),
          })
        : recomputeNodeStatus(node, { dependenciesSatisfied });

    visiting.delete(nodeId);
    cache.set(nodeId, status);
    return status;
  };

  return nodes.map((node) => ({ id: node.id, status: computeNode(node.id) }));
}

function groupSessionNodes(nodes: GoalNode[]) {
  const sessionsByBaseUrl = new Map<string, string[]>();

  for (const node of nodes) {
    if (node.type !== "session") {
      continue;
    }

    const sessionIds = sessionsByBaseUrl.get(node.execution_base_url) ?? [];
    sessionIds.push(node.external_session_id);
    sessionsByBaseUrl.set(node.execution_base_url, sessionIds);
  }

  return sessionsByBaseUrl;
}

export function createGoalScheduler(options: CreateGoalSchedulerOptions) {
  return {
    async runCycle(): Promise<GoalSchedulerRunResult> {
      const initialNodes = options.service.listTree();
      const executionStatuses = new Map<string, ExecutionSessionStatus>();

      for (const [baseUrl, sessionIds] of groupSessionNodes(initialNodes)) {
        const client = options.executionClientFactory.getClient(baseUrl);
        const items = await client.getSessionStatuses(sessionIds);
        for (const item of items) {
          executionStatuses.set(item.sessionId, item.status);
        }
      }

      const recomputedStatuses = computeStatuses(initialNodes, executionStatuses);
      const recomputedNodes = options.service.syncComputedStatuses(recomputedStatuses);
      const selection = selectGreedyGoalPath(recomputedNodes, options.chooser);
      const decision = await options.decideActivation({ nodes: recomputedNodes, selection });

      options.service.applySchedulerMutations(decision.mutations ?? []);

      let externalWrites = 0;

      if (decision.action.type === "noop") {
        return {
          refreshedNodes: recomputedNodes.length,
          action: "noop",
          externalWrites,
        };
      }

      if (decision.action.type === "append_session") {
        const sessionNode = options.service.getNode(decision.action.sessionNodeId);
        if (!sessionNode || sessionNode.type !== "session") {
          throw new GoalServiceError("scheduler append target not found", 404, "NOT_FOUND");
        }

        if (executionStatuses.get(sessionNode.external_session_id) !== "idle") {
          throw new Error("execution session is not idle");
        }

        if (sessionNode.status !== "todo") {
          throw new Error("scheduler append target is not appendable");
        }

        const client = options.executionClientFactory.getClient(sessionNode.execution_base_url);
        const appendResult = await client.appendSessionMessage(
          sessionNode.external_session_id,
          decision.action.content,
        );
        if (!appendResult.accepted) {
          throw new Error("execution append was not accepted");
        }
        externalWrites += 1;
      }

      if (decision.action.type === "create_session") {
        const nodeId = decision.action.input.id ?? crypto.randomUUID();
        options.service.validateSessionNodeCreation({
          id: nodeId,
          parent_id: decision.action.input.parent_id,
          title: decision.action.input.title,
          objective: decision.action.input.objective,
          dependency_ids: decision.action.input.dependency_ids,
          execution_base_url: decision.action.input.execution_base_url,
          external_session_id: "pending-external-session",
        });

        const client = options.executionClientFactory.getClient(
          decision.action.input.execution_base_url,
        );
        const created = await client.createSession({
          title: decision.action.input.title,
          objective: decision.action.input.objective,
          initialContext: decision.action.input.initial_context,
          metadata: {
            remi_node_id: nodeId,
            user_identity_pubkey: options.userIdentityPubkey,
          },
        });

        options.service.createSessionNode({
          id: nodeId,
          parent_id: decision.action.input.parent_id,
          title: decision.action.input.title,
          objective: decision.action.input.objective,
          dependency_ids: decision.action.input.dependency_ids,
          execution_base_url: decision.action.input.execution_base_url,
          external_session_id: created.sessionId,
        });

        externalWrites += 1;
      }

      if (externalWrites > 1) {
        throw new Error("scheduler cycle exceeded one external write");
      }

      return {
        refreshedNodes: recomputedNodes.length,
        action: decision.action.type,
        externalWrites,
      };
    },
  };
}
