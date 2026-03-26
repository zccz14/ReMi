import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { CreateRootGoalInput } from "./types.js";
import {
  createGoalsService,
  type CreateActivationSessionNodeInput,
  type CreateGoalNodeInput,
} from "./service.js";

interface GoalTreeMutationConnection {
  drizzle: BetterSQLite3Database;
  raw: Database.Database;
}

export function createGoalTreeMutator(conn: GoalTreeMutationConnection) {
  const service = createGoalsService(conn);

  return {
    createRootGoal(
      input: Omit<CreateRootGoalInput, "status"> & { status?: CreateRootGoalInput["status"] },
    ) {
      return service.createRootGoal({ ...input, status: input.status ?? "todo" });
    },

    createGoalNode(input: CreateGoalNodeInput) {
      return service.createGoalNode({ ...input, status: input.status ?? "todo" });
    },

    createSessionNode(input: CreateActivationSessionNodeInput) {
      return service.createSessionNode({ ...input, status: input.status ?? "todo" });
    },

    updateNodeDependencies(input: { id: string; dependency_ids: string[] }) {
      return service.updateNodeDependencies(input);
    },

    getNode(id: string) {
      return service.getNode(id);
    },
  };
}
