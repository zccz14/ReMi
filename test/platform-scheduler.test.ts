import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConnectionManager } from "../packages/server/src/db/connection";
import { createGoalsService } from "../packages/server/src/goals/service";
import {
  buildDefaultSchedulerDecision,
  createGoalScheduler,
} from "../packages/server/src/goals/scheduler";
import {
  createPlatformRunner,
  parsePlatformRunnerConfig,
} from "../packages/server/src/goals/platform-runner";

describe("platform goal scheduler", () => {
  let tmpDir: string;
  let connMgr: ConnectionManager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `remi-platform-scheduler-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    connMgr = new ConnectionManager(tmpDir, { embeddingDimensions: 4 });
  });

  afterEach(() => {
    connMgr.closeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs one activation cycle with refresh, recompute, selection, maintenance, and one append", async () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const service = createGoalsService(conn);
    const root = service.createRootGoal({
      title: "Root",
      objective: "Ship the work",
      status: "todo",
    });
    const branch = service.createGoalNode({
      parent_id: root.id,
      title: "Branch",
      objective: "Do the next thing",
    });
    const session = service.createSessionNode({
      parent_id: branch.id,
      title: "Existing session",
      objective: "Advance the task",
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-idle",
    });

    const appendSessionMessage = vi.fn().mockResolvedValue({
      sessionId: "sess-idle",
      accepted: true,
      status: "running",
    });
    const createSession = vi.fn();
    const getSessionStatuses = vi
      .fn()
      .mockResolvedValue([{ sessionId: "sess-idle", status: "idle", updatedAt: 1770000000000 }]);

    const scheduler = createGoalScheduler({
      userIdentityPubkey: "owner-key",
      service,
      chooser: {
        chooseChild(candidates) {
          return candidates[0]?.id ?? null;
        },
      },
      executionClientFactory: {
        getClient() {
          return {
            getSessionStatuses,
            appendSessionMessage,
            createSession,
          };
        },
      },
      decideActivation({ selection }) {
        expect(selection?.terminal.id).toBe(session.id);

        return {
          mutations: [
            {
              type: "create_goal",
              input: {
                parent_id: branch.id,
                title: "Fresh child",
                objective: "Persist local tree maintenance",
              },
            },
          ],
          action: {
            type: "append_session",
            sessionNodeId: session.id,
            content: "continue from the latest constraints",
          },
        };
      },
    });

    await expect(scheduler.runCycle()).resolves.toMatchObject({
      action: "append_session",
      externalWrites: 1,
    });

    expect(getSessionStatuses).toHaveBeenCalledWith(["sess-idle"]);
    expect(appendSessionMessage).toHaveBeenCalledOnce();
    expect(appendSessionMessage).toHaveBeenCalledWith(
      "sess-idle",
      "continue from the latest constraints",
    );
    expect(createSession).not.toHaveBeenCalled();
    expect(service.listTree().some((node) => node.title === "Fresh child")).toBe(true);
  });

  it("rejects scheduler-triggered mutations that violate dependency validation", async () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const service = createGoalsService(conn);
    const root = service.createRootGoal({
      title: "Root",
      objective: "Ship the work",
      status: "todo",
    });
    const session = service.createSessionNode({
      parent_id: root.id,
      title: "Existing session",
      objective: "Advance the task",
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-idle",
    });

    const appendSessionMessage = vi.fn();

    const scheduler = createGoalScheduler({
      userIdentityPubkey: "owner-key",
      service,
      chooser: {
        chooseChild(candidates) {
          return candidates[0]?.id ?? null;
        },
      },
      executionClientFactory: {
        getClient() {
          return {
            getSessionStatuses: vi
              .fn()
              .mockResolvedValue([
                { sessionId: "sess-idle", status: "idle", updatedAt: 1770000000000 },
              ]),
            appendSessionMessage,
            createSession: vi.fn(),
          };
        },
      },
      decideActivation() {
        return {
          mutations: [
            {
              type: "create_goal",
              input: {
                id: "self-dependency-node",
                parent_id: root.id,
                title: "Broken child",
                objective: "Should be rejected",
                dependency_ids: ["self-dependency-node"],
              },
            },
          ],
          action: {
            type: "append_session",
            sessionNodeId: session.id,
            content: "should never append",
          },
        };
      },
    });

    await expect(scheduler.runCycle()).rejects.toThrow("node cannot depend on itself");
    expect(appendSessionMessage).not.toHaveBeenCalled();
  });

  it("creates a new external session and persists the complete local session node", async () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const service = createGoalsService(conn);
    const root = service.createRootGoal({
      title: "Root",
      objective: "Ship the work",
      status: "todo",
    });
    const branch = service.createGoalNode({
      parent_id: root.id,
      title: "Branch",
      objective: "Organize work",
    });
    service.createSessionNode({
      parent_id: branch.id,
      title: "Existing session",
      objective: "Keeps the path selectable",
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-existing",
    });

    const createSession = vi.fn().mockResolvedValue({ sessionId: "sess-new", status: "running" });
    const appendSessionMessage = vi.fn();

    const scheduler = createGoalScheduler({
      userIdentityPubkey: "owner-key",
      service,
      chooser: {
        chooseChild(candidates) {
          return candidates[0]?.id ?? null;
        },
      },
      executionClientFactory: {
        getClient() {
          return {
            getSessionStatuses: vi
              .fn()
              .mockResolvedValue([
                { sessionId: "sess-existing", status: "idle", updatedAt: 1770000000000 },
              ]),
            appendSessionMessage,
            createSession,
          };
        },
      },
      decideActivation() {
        return {
          mutations: [],
          action: {
            type: "create_session",
            input: {
              parent_id: branch.id,
              title: "New external session",
              objective: "Spawn a fresh execution leaf",
              execution_base_url: "https://exec.example.test",
              initial_context: "launch from the current branch state",
            },
          },
        };
      },
    });

    await expect(scheduler.runCycle()).resolves.toMatchObject({
      action: "create_session",
      externalWrites: 1,
    });

    expect(createSession).toHaveBeenCalledOnce();
    expect(appendSessionMessage).not.toHaveBeenCalled();

    const createdNode = service.listTree().find((node) => node.external_session_id === "sess-new");
    expect(createdNode).toMatchObject({
      type: "session",
      parent_id: branch.id,
      title: "New external session",
      objective: "Spawn a fresh execution leaf",
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-new",
    });
  });

  it("rejects append when the targeted execution state is not idle", async () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const service = createGoalsService(conn);
    const root = service.createRootGoal({
      title: "Root",
      objective: "Ship the work",
      status: "todo",
    });
    const branch = service.createGoalNode({
      parent_id: root.id,
      title: "Branch",
      objective: "Do the next thing",
    });
    service.createSessionNode({
      parent_id: branch.id,
      title: "Idle session",
      objective: "Keeps the path selectable",
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-idle",
    });
    const runningSession = service.createSessionNode({
      parent_id: branch.id,
      title: "Running session",
      objective: "Should reject append",
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-running",
    });

    const appendSessionMessage = vi.fn();

    const scheduler = createGoalScheduler({
      userIdentityPubkey: "owner-key",
      service,
      chooser: {
        chooseChild(candidates) {
          return candidates[0]?.id ?? null;
        },
      },
      executionClientFactory: {
        getClient() {
          return {
            getSessionStatuses: vi.fn().mockResolvedValue([
              { sessionId: "sess-idle", status: "idle", updatedAt: 1770000000000 },
              { sessionId: "sess-running", status: "running", updatedAt: 1770000000001 },
            ]),
            appendSessionMessage,
            createSession: vi.fn(),
          };
        },
      },
      decideActivation() {
        return {
          mutations: [],
          action: {
            type: "append_session",
            sessionNodeId: runningSession.id,
            content: "attempt append while running",
          },
        };
      },
    });

    await expect(scheduler.runCycle()).rejects.toThrow("execution session is not idle");
    expect(appendSessionMessage).not.toHaveBeenCalled();
  });

  it("rejects append responses that are not accepted", async () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const service = createGoalsService(conn);
    const root = service.createRootGoal({
      title: "Root",
      objective: "Ship the work",
      status: "todo",
    });
    const branch = service.createGoalNode({
      parent_id: root.id,
      title: "Branch",
      objective: "Do the next thing",
    });
    const session = service.createSessionNode({
      parent_id: branch.id,
      title: "Existing session",
      objective: "Advance the task",
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-idle",
    });

    const scheduler = createGoalScheduler({
      userIdentityPubkey: "owner-key",
      service,
      chooser: {
        chooseChild(candidates) {
          return candidates[0]?.id ?? null;
        },
      },
      executionClientFactory: {
        getClient() {
          return {
            getSessionStatuses: vi
              .fn()
              .mockResolvedValue([
                { sessionId: "sess-idle", status: "idle", updatedAt: 1770000000000 },
              ]),
            appendSessionMessage: vi.fn().mockResolvedValue({
              sessionId: "sess-idle",
              accepted: false,
              status: "idle",
            }),
            createSession: vi.fn(),
          };
        },
      },
      decideActivation() {
        return {
          action: {
            type: "append_session",
            sessionNodeId: session.id,
            content: "attempt append",
          },
        };
      },
    });

    await expect(scheduler.runCycle()).rejects.toThrow("execution append was not accepted");
  });

  it("rejects stale append actions after mutations make the target unappendable", async () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const service = createGoalsService(conn);
    const root = service.createRootGoal({
      title: "Root",
      objective: "Ship the work",
      status: "todo",
    });
    const branch = service.createGoalNode({
      parent_id: root.id,
      title: "Branch",
      objective: "Do the next thing",
    });
    const session = service.createSessionNode({
      parent_id: branch.id,
      title: "Existing session",
      objective: "Advance the task",
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-idle",
    });

    const appendSessionMessage = vi.fn();

    const scheduler = createGoalScheduler({
      userIdentityPubkey: "owner-key",
      service,
      chooser: {
        chooseChild(candidates) {
          return candidates[0]?.id ?? null;
        },
      },
      executionClientFactory: {
        getClient() {
          return {
            getSessionStatuses: vi
              .fn()
              .mockResolvedValue([
                { sessionId: "sess-idle", status: "idle", updatedAt: 1770000000000 },
              ]),
            appendSessionMessage,
            createSession: vi.fn(),
          };
        },
      },
      decideActivation() {
        return {
          mutations: [{ type: "cancel_node", nodeId: session.id }],
          action: {
            type: "append_session",
            sessionNodeId: session.id,
            content: "should not append after cancel",
          },
        };
      },
    });

    await expect(scheduler.runCycle()).rejects.toThrow("scheduler append target is not appendable");
    expect(appendSessionMessage).not.toHaveBeenCalled();
  });

  it("rejects refresh cycles with missing session status data", async () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const service = createGoalsService(conn);
    const root = service.createRootGoal({
      title: "Root",
      objective: "Ship the work",
      status: "todo",
    });
    const branch = service.createGoalNode({
      parent_id: root.id,
      title: "Branch",
      objective: "Do the next thing",
    });
    service.createSessionNode({
      parent_id: branch.id,
      title: "Existing session",
      objective: "Advance the task",
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-missing",
    });

    const scheduler = createGoalScheduler({
      userIdentityPubkey: "owner-key",
      service,
      chooser: {
        chooseChild(candidates) {
          return candidates[0]?.id ?? null;
        },
      },
      executionClientFactory: {
        getClient() {
          return {
            getSessionStatuses: vi.fn().mockResolvedValue([]),
            appendSessionMessage: vi.fn(),
            createSession: vi.fn(),
          };
        },
      },
      decideActivation() {
        return { action: { type: "noop" } };
      },
    });

    await expect(scheduler.runCycle()).rejects.toThrow(
      "missing execution status for session sess-missing",
    );
  });

  it("does not require refresh data for locally cancelled sessions", async () => {
    const conn = connMgr.getConnection("owner-key", { create: true });
    const service = createGoalsService(conn);
    const root = service.createRootGoal({
      title: "Root",
      objective: "Ship the work",
      status: "todo",
    });
    const branch = service.createGoalNode({
      parent_id: root.id,
      title: "Branch",
      objective: "Do the next thing",
    });
    const session = service.createSessionNode({
      parent_id: branch.id,
      title: "Cancelled session",
      objective: "No longer active",
      execution_base_url: "https://exec.example.test",
      external_session_id: "sess-cancelled",
    });

    service.updateNodeStatus(session.id, "cancelled");

    const scheduler = createGoalScheduler({
      userIdentityPubkey: "owner-key",
      service,
      chooser: {
        chooseChild(candidates) {
          return candidates[0]?.id ?? null;
        },
      },
      executionClientFactory: {
        getClient() {
          return {
            getSessionStatuses: vi.fn().mockResolvedValue([]),
            appendSessionMessage: vi.fn(),
            createSession: vi.fn(),
          };
        },
      },
      decideActivation() {
        return { action: { type: "noop" } };
      },
    });

    await expect(scheduler.runCycle()).resolves.toMatchObject({ action: "noop" });
  });

  it("defaults to noop when no appendable session is selected", () => {
    const decision = buildDefaultSchedulerDecision({
      selection: null,
      nodes: [
        {
          id: "root",
          parent_id: null,
          type: "goal",
          title: "Root",
          objective: "Root objective",
          status: "todo",
          dependency_ids: [],
          execution_base_url: null,
          external_session_id: null,
        },
        {
          id: "branch",
          parent_id: "root",
          type: "goal",
          title: "Branch",
          objective: "Branch objective",
          status: "todo",
          dependency_ids: [],
          execution_base_url: null,
          external_session_id: null,
        },
        {
          id: "running-session",
          parent_id: "branch",
          type: "session",
          title: "Running session",
          objective: "Already busy",
          status: "running",
          dependency_ids: [],
          execution_base_url: "https://exec.example.test",
          external_session_id: "sess-running",
        },
      ],
    });

    expect(decision).toEqual({ action: { type: "noop" } });
  });
});

describe("platform runner", () => {
  it("parses the enable flag and interval from env", () => {
    expect(
      parsePlatformRunnerConfig({
        PLATFORM_SCHEDULER_ENABLED: "true",
        PLATFORM_SCHEDULER_INTERVAL_MS: "2500",
      }),
    ).toEqual({ enabled: true, intervalMs: 2500 });

    expect(
      parsePlatformRunnerConfig({
        PLATFORM_SCHEDULER_ENABLED: "0",
        PLATFORM_SCHEDULER_INTERVAL_MS: "2500",
      }),
    ).toEqual({ enabled: false, intervalMs: 2500 });
  });

  it("is a no-op when disabled", () => {
    const setInterval = vi.fn();
    const activateUser = vi.fn();

    const runner = createPlatformRunner({
      config: { enabled: false, intervalMs: 1000 },
      listEligibleUsers: () => ["user-a"],
      activateUser,
      timers: {
        setInterval,
        clearInterval: vi.fn(),
      },
    });

    const started = runner.start();

    expect(started).toBe(false);
    expect(setInterval).not.toHaveBeenCalled();
    expect(activateUser).not.toHaveBeenCalled();
  });

  it("runs eligible users in fixed-interval round-robin order", async () => {
    const activateUser = vi.fn().mockResolvedValue(undefined);

    const runner = createPlatformRunner({
      config: { enabled: true, intervalMs: 1000 },
      listEligibleUsers: () => ["user-a", "user-b", "user-c"],
      activateUser,
      timers: {
        setInterval() {
          return 1 as unknown as ReturnType<typeof globalThis.setInterval>;
        },
        clearInterval: vi.fn(),
      },
    });

    expect(runner.start()).toBe(true);
    await runner.tick();
    await runner.tick();
    await runner.tick();

    expect(activateUser.mock.calls.map(([pubKey]) => pubKey)).toEqual([
      "user-a",
      "user-b",
      "user-c",
    ]);
  });

  it("does not trigger a second activation while the current tick is still running", async () => {
    let resolveActivation: (() => void) | undefined;
    const activateUser = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveActivation = resolve;
        }),
    );

    const runner = createPlatformRunner({
      config: { enabled: true, intervalMs: 1000 },
      listEligibleUsers: () => ["user-a", "user-b"],
      activateUser,
      timers: {
        setInterval() {
          return 1 as unknown as ReturnType<typeof globalThis.setInterval>;
        },
        clearInterval: vi.fn(),
      },
    });

    runner.start();
    const firstTick = runner.tick();
    const secondTick = runner.tick();
    await Promise.resolve();

    expect(activateUser).toHaveBeenCalledTimes(1);

    resolveActivation?.();
    await firstTick;
    await secondTick;
  });

  it("captures async runner errors instead of leaking rejections", async () => {
    let scheduledTick: (() => void) | undefined;
    const onError = vi.fn();

    const runner = createPlatformRunner({
      config: { enabled: true, intervalMs: 1000 },
      listEligibleUsers: () => ["user-a"],
      activateUser: vi.fn().mockRejectedValue(new Error("boom")),
      onError,
      timers: {
        setInterval(callback) {
          scheduledTick = callback as () => void;
          return 1 as unknown as ReturnType<typeof globalThis.setInterval>;
        },
        clearInterval: vi.fn(),
      },
    });

    runner.start();
    scheduledTick?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});
