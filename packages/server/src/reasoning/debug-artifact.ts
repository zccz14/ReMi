import { lstat, mkdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { ChatMessage } from "../llm/client.js";
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
  recallRounds: Array<
    Omit<RecallRoundSummary, "stoppedCandidate"> & { stoppedCandidate: string | null }
  >;
  finalPrompt: string;
  response: string;
  summary: ReasoningDebugArtifactSummary;
}

export interface ReasoningDebugArtifactWriter {
  writeLatest(payload: ReasoningDebugArtifactPayload): Promise<void>;
  writeLatestRuntimeTrace(payload: ReasoningRuntimeDebugArtifactPayload): Promise<void>;
}

export interface ReasoningDebugTurn {
  turnId: string;
  promptMessages?: ChatMessage[];
  promptText?: string;
  responseText: string;
  responseJson?: unknown;
}

export interface ReasoningRuntimeDebugArtifactPayload {
  turns: ReasoningDebugTurn[];
  finalMessages: ChatMessage[];
  recallRounds: Array<
    Omit<RecallRoundSummary, "stoppedCandidate"> & { stoppedCandidate: string | null }
  >;
  response: string;
  summary: ReasoningDebugArtifactSummary;
}

interface ReasoningDebugArtifactTestHooks {
  beforeSwap?(): void | Promise<void>;
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function renderReadableMessages(messages: ChatMessage[]): string {
  return `${messages
    .map((message) => `[role: ${message.role}]\n${message.content}`)
    .join("\n\n")}\n`;
}

function renderPromptMarkdown(turn: ReasoningDebugTurn): string {
  if (turn.promptMessages) {
    return renderReadableMessages(turn.promptMessages);
  }

  return `${turn.promptText ?? ""}\n`;
}

function getPromptJson(turn: ReasoningDebugTurn): unknown {
  if (turn.promptMessages) {
    return turn.promptMessages;
  }

  return { promptText: turn.promptText ?? "" };
}

function isWithinDirectory(rootDir: string, candidatePath: string): boolean {
  const relativePath = relative(rootDir, candidatePath);
  return relativePath !== "" && !relativePath.startsWith("..") && !relativePath.includes(`..`);
}

async function writeLatestReasoningDirectory(
  baseDir: string,
  payload: ReasoningDebugArtifactPayload,
  testHooks?: ReasoningDebugArtifactTestHooks,
): Promise<void> {
  return writeLatestReasoningFiles(baseDir, testHooks, async (versionDir) => {
    await Promise.all([
      writeFile(join(versionDir, "request.json"), formatJson(payload.request), "utf8"),
      writeFile(join(versionDir, "decomposition.json"), formatJson(payload.decomposition), "utf8"),
      writeFile(join(versionDir, "recall-rounds.json"), formatJson(payload.recallRounds), "utf8"),
      writeFile(join(versionDir, "final-prompt.md"), payload.finalPrompt, "utf8"),
      writeFile(join(versionDir, "response.txt"), payload.response, "utf8"),
      writeFile(join(versionDir, "summary.json"), formatJson(payload.summary), "utf8"),
    ]);
  });
}

async function writeLatestRuntimeTraceDirectory(
  baseDir: string,
  payload: ReasoningRuntimeDebugArtifactPayload,
  testHooks?: ReasoningDebugArtifactTestHooks,
): Promise<void> {
  return writeLatestReasoningFiles(baseDir, testHooks, async (versionDir) => {
    const writes = payload.turns.flatMap((turn) => {
      const entries = [
        writeFile(join(versionDir, `${turn.turnId}-prompt.md`), renderPromptMarkdown(turn), "utf8"),
        writeFile(
          join(versionDir, `${turn.turnId}-prompt.json`),
          formatJson(getPromptJson(turn)),
          "utf8",
        ),
        writeFile(join(versionDir, `${turn.turnId}-response.txt`), turn.responseText, "utf8"),
      ];

      if (turn.responseJson !== undefined) {
        entries.push(
          writeFile(
            join(versionDir, `${turn.turnId}-response.json`),
            formatJson(turn.responseJson),
            "utf8",
          ),
        );
      }

      return entries;
    });

    await Promise.all([
      ...writes,
      writeFile(join(versionDir, "final-messages.json"), formatJson(payload.finalMessages), "utf8"),
      writeFile(
        join(versionDir, "final-prompt.md"),
        renderReadableMessages(payload.finalMessages),
        "utf8",
      ),
      writeFile(join(versionDir, "recall-rounds.json"), formatJson(payload.recallRounds), "utf8"),
      writeFile(join(versionDir, "response.txt"), payload.response, "utf8"),
      writeFile(join(versionDir, "summary.json"), formatJson(payload.summary), "utf8"),
    ]);
  });
}

async function writeLatestReasoningFiles(
  baseDir: string,
  testHooks: ReasoningDebugArtifactTestHooks | undefined,
  writeVersionFiles: (versionDir: string) => Promise<void>,
): Promise<void> {
  const debugDir = join(baseDir, "debug");
  const versionsDir = join(debugDir, ".reasoning-last-versions");
  const latestDir = join(debugDir, "reasoning-last");
  const versionSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const versionDir = join(versionsDir, versionSuffix);
  const nextLink = join(debugDir, `.reasoning-last-link-${versionSuffix}`);
  const legacyBackupDir = join(debugDir, `.reasoning-last-legacy-${versionSuffix}`);
  let previousVersionDir: string | null = null;
  let existingLatestIsRealDirectory = false;

  await mkdir(debugDir, { recursive: true });
  await mkdir(versionsDir, { recursive: true });
  await rm(versionDir, { recursive: true, force: true });
  await rm(nextLink, { recursive: true, force: true });
  await rm(legacyBackupDir, { recursive: true, force: true });
  await mkdir(versionDir, { recursive: true });

  await writeVersionFiles(versionDir);

  try {
    const latestStat = await lstat(latestDir);
    if (latestStat.isSymbolicLink()) {
      previousVersionDir = resolve(debugDir, await readlink(latestDir));
    } else if (latestStat.isDirectory()) {
      existingLatestIsRealDirectory = true;
    }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ENOENT" &&
      (error as NodeJS.ErrnoException).code !== "EINVAL"
    ) {
      throw error;
    }
  }

  try {
    await symlink(relative(debugDir, versionDir), nextLink, "dir");
    await testHooks?.beforeSwap?.();
    if (existingLatestIsRealDirectory) {
      await rename(latestDir, legacyBackupDir);
    }
    await rename(nextLink, latestDir);
  } catch (error) {
    if (existingLatestIsRealDirectory) {
      try {
        await rename(legacyBackupDir, latestDir);
      } catch {
        // Best effort restore; keep original error path.
      }
    }
    await rm(nextLink, { recursive: true, force: true });
    await rm(versionDir, { recursive: true, force: true });
    throw error;
  }

  await rm(legacyBackupDir, { recursive: true, force: true });

  if (
    previousVersionDir &&
    previousVersionDir !== versionDir &&
    isWithinDirectory(versionsDir, previousVersionDir)
  ) {
    await rm(previousVersionDir, { recursive: true, force: true });
  }
}

export function createLatestReasoningDebugArtifactWriter(options: {
  rootDir: string;
  testHooks?: ReasoningDebugArtifactTestHooks;
}): ReasoningDebugArtifactWriter {
  return {
    async writeLatest(payload) {
      await writeLatestReasoningDirectory(options.rootDir, payload, options.testHooks);
    },
    async writeLatestRuntimeTrace(payload) {
      await writeLatestRuntimeTraceDirectory(options.rootDir, payload, options.testHooks);
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
  requiredGoalIds: string[];
}): ReasoningDebugArtifactSummary {
  const requiredGoalIds = new Set(input.requiredGoalIds);
  return {
    currentTime: input.currentTime,
    userQuery: input.userQuery,
    rounds: input.rounds,
    stoppedBecause: input.stoppedBecause ?? null,
    finalAnchorIds: input.finalAnchorIds,
    hasUnsatisfiedRequiredGoal: input.goalStatus.some(
      (goal) => requiredGoalIds.has(goal.goalId) && !goal.sufficient,
    ),
  };
}
