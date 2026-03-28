import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { GoalStatus, RecallRoundSummary } from "../recall/goal-based-recall.js";

export interface ReasoningDebugArtifactSummary {
  currentTime: string;
  userQuery: string;
  rounds: number;
  stoppedBecause: string | null;
  finalAnchorIds: string[];
  hasUnsatisfiedRequiredGoal: boolean;
}

export interface ReasoningDebugArtifactPayload {
  request: Record<string, unknown>;
  decomposition: Record<string, unknown>;
  recallRounds: RecallRoundSummary[];
  finalPrompt: string;
  response: string;
  summary: ReasoningDebugArtifactSummary;
}

export interface ReasoningDebugArtifactWriter {
  writeLatest(payload: ReasoningDebugArtifactPayload): Promise<void>;
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeLatestReasoningDirectory(
  baseDir: string,
  payload: ReasoningDebugArtifactPayload,
): Promise<void> {
  const debugDir = join(baseDir, "debug");
  const latestDir = join(debugDir, "reasoning-last");
  const versionSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const nextDir = join(debugDir, `.reasoning-last-next-${versionSuffix}`);
  const previousDir = join(debugDir, `.reasoning-last-prev-${versionSuffix}`);

  await mkdir(debugDir, { recursive: true });
  await rm(nextDir, { recursive: true, force: true });
  await rm(previousDir, { recursive: true, force: true });
  await mkdir(nextDir, { recursive: true });

  await Promise.all([
    writeFile(join(nextDir, "request.json"), formatJson(payload.request), "utf8"),
    writeFile(join(nextDir, "decomposition.json"), formatJson(payload.decomposition), "utf8"),
    writeFile(join(nextDir, "recall-rounds.json"), formatJson(payload.recallRounds), "utf8"),
    writeFile(join(nextDir, "final-prompt.md"), payload.finalPrompt, "utf8"),
    writeFile(join(nextDir, "response.txt"), payload.response, "utf8"),
    writeFile(join(nextDir, "summary.json"), formatJson(payload.summary), "utf8"),
  ]);

  try {
    await rename(latestDir, previousDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await rename(nextDir, latestDir);
  } catch (error) {
    await rm(nextDir, { recursive: true, force: true });
    throw error;
  }

  await rm(previousDir, { recursive: true, force: true });
}

export function createLatestReasoningDebugArtifactWriter(options: {
  rootDir: string;
}): ReasoningDebugArtifactWriter {
  return {
    async writeLatest(payload) {
      await writeLatestReasoningDirectory(options.rootDir, payload);
    },
  };
}

export function buildReasoningDebugArtifactSummary(input: {
  currentTime: string;
  userQuery: string;
  rounds: number;
  stoppedBecause?: string;
  finalAnchorIds: string[];
  goalStatus: GoalStatus[];
}): ReasoningDebugArtifactSummary {
  return {
    currentTime: input.currentTime,
    userQuery: input.userQuery,
    rounds: input.rounds,
    stoppedBecause: input.stoppedBecause ?? null,
    finalAnchorIds: input.finalAnchorIds,
    hasUnsatisfiedRequiredGoal: input.goalStatus.some((goal) => !goal.sufficient),
  };
}
