import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { InterviewEngine, type EngineDeps, type SSEEmitter } from "../../src/interview/engine.js";
import type { ChatClient } from "../../src/llm/client.js";
import { extractAnchors } from "../../src/interview/extractor.js";
import { agenticRecall } from "../../src/interview/recall.js";
import { detectContradictions } from "../../src/interview/contradiction.js";

vi.mock("../../src/interview/extractor.js", () => ({
  extractAnchors: vi.fn(),
}));

vi.mock("../../src/interview/recall.js", () => ({
  agenticRecall: vi.fn(),
}));

vi.mock("../../src/interview/contradiction.js", () => ({
  detectContradictions: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, maxTicks = 20): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Condition not met within expected ticks");
}

function createMockDeps(overrides: Partial<EngineDeps> = {}) {
  const chatClient: ChatClient = {
    chat: vi.fn(),
    chatStream: vi.fn().mockReturnValue(
      (async function* () {
        yield "回";
        yield "复";
      })(),
    ),
  };

  const deps: EngineDeps = {
    chatClient,
    embeddingClient: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) },
    cleanupEmptyAssistantMessages: vi.fn().mockResolvedValue(0),
    getMessages: vi
      .fn()
      .mockResolvedValue([{ id: 1, role: "assistant", content: "你好", created_at: Date.now() }]),
    saveMessage: vi.fn().mockResolvedValue(2),
    getAnchors: vi.fn().mockResolvedValue([]),
    saveAnchors: vi.fn().mockResolvedValue(undefined),
    searchAnchors: vi.fn().mockResolvedValue([]),
    getAnchorCount: vi.fn().mockResolvedValue(0),
    ...overrides,
  };

  return deps;
}

function createEmptyStream(): AsyncGenerator<string, void, unknown> {
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      return { value: undefined, done: true };
    },
  } as AsyncGenerator<string, void, unknown>;
}

function createRecorderEmitter() {
  const events: { type: string; data?: unknown }[] = [];
  const emitter: SSEEmitter = {
    emitThinking: (n) => {
      events.push({ type: "thinking", data: n });
    },
    emitToken: (c) => {
      events.push({ type: "token", data: c });
    },
    emitDone: (d) => {
      events.push({ type: "done", data: d });
    },
    emitError: (code, message) => {
      events.push({ type: "error", data: { code, message } });
    },
    emitPhase: (data) => {
      events.push({ type: "phase", data });
    },
  };
  return { events, emitter };
}

function assertProtocolInvariants(events: { type: string; data?: unknown }[]) {
  expect(events.length).toBeGreaterThan(0);
  expect(["phase", "thinking", "token"]).toContain(events[0].type);

  const doneIndex = events.findIndex((e) => e.type === "done");
  const errorIndex = events.findIndex((e) => e.type === "error");

  expect(doneIndex >= 0 || errorIndex >= 0).toBe(true);
  expect(doneIndex >= 0 && errorIndex >= 0).toBe(false);

  const terminalIndex = doneIndex >= 0 ? doneIndex : errorIndex;
  expect(terminalIndex).toBe(events.length - 1);
  expect(events.slice(terminalIndex + 1).some((e) => e.type === "token")).toBe(false);
}

const mockExtractAnchors = vi.mocked(extractAnchors);
const mockAgenticRecall = vi.mocked(agenticRecall);
const mockDetectContradictions = vi.mocked(detectContradictions);

describe("InterviewEngine", () => {
  const env = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...env };
    delete process.env.REMI_CONVERSATION_FLOW_V2;
    delete process.env.REMI_INJECT_INTERVIEW_FAILURE;
    delete process.env.NODE_ENV;

    mockExtractAnchors.mockResolvedValue([{ question: "价值观", answer: "诚实" }]);
    mockAgenticRecall.mockResolvedValue({
      anchors: [],
      narratives: ["想好了"],
      rounds: 1,
      sufficient: true,
    });
    mockDetectContradictions.mockResolvedValue([]);
  });

  afterEach(() => {
    process.env = { ...env };
  });

  it("start flow still emits legacy events and now includes phase", async () => {
    process.env.REMI_CONVERSATION_FLOW_V2 = "full";
    const deps = createMockDeps({
      getMessages: vi.fn().mockResolvedValue([]),
      saveMessage: vi.fn().mockResolvedValue(1),
    });
    const engine = new InterviewEngine(deps);
    const { events, emitter } = createRecorderEmitter();

    await engine.start(emitter);

    expect(events.some((e) => e.type === "phase")).toBe(true);
    expect(events.some((e) => e.type === "token")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("mode=off keeps sequential behavior and emits no phase", async () => {
    process.env.REMI_CONVERSATION_FLOW_V2 = "off";
    const steps: string[] = [];
    mockExtractAnchors.mockImplementation(async () => {
      steps.push("extract");
      return [{ question: "q", answer: "a" }];
    });
    mockAgenticRecall.mockImplementation(async () => {
      steps.push("recall");
      return { anchors: [], narratives: [], rounds: 1, sufficient: true };
    });

    const deps = createMockDeps();
    const engine = new InterviewEngine(deps);
    const { events, emitter } = createRecorderEmitter();

    await engine.handleMessage("hello", emitter);

    expect(steps).toEqual(["extract", "recall"]);
    expect(events.some((e) => e.type === "phase")).toBe(false);
    assertProtocolInvariants(events);
  });

  it("mode=observability-only emits phase and stays sequential", async () => {
    process.env.REMI_CONVERSATION_FLOW_V2 = "observability-only";
    const steps: string[] = [];
    mockExtractAnchors.mockImplementation(async () => {
      steps.push("extract");
      return [{ question: "q", answer: "a" }];
    });
    mockAgenticRecall.mockImplementation(async () => {
      steps.push("recall");
      return { anchors: [], narratives: [], rounds: 1, sufficient: true };
    });

    const deps = createMockDeps();
    const engine = new InterviewEngine(deps);
    const { events, emitter } = createRecorderEmitter();

    await engine.handleMessage("hello", emitter);

    expect(steps).toEqual(["extract", "recall"]);
    expect(events.some((e) => e.type === "phase")).toBe(true);
    assertProtocolInvariants(events);
  });

  it("mode=full starts extract and recall concurrently", async () => {
    process.env.REMI_CONVERSATION_FLOW_V2 = "full";
    const started: string[] = [];
    const extractDfd = deferred<{ question: string; answer: string }[]>();
    const recallDfd = deferred<{ anchors: []; narratives: []; rounds: number; sufficient: true }>();

    mockExtractAnchors.mockImplementation(() => {
      started.push("extract");
      return extractDfd.promise;
    });
    mockAgenticRecall.mockImplementation(() => {
      started.push("recall");
      return recallDfd.promise;
    });

    const deps = createMockDeps();
    const engine = new InterviewEngine(deps);
    const { events, emitter } = createRecorderEmitter();

    const run = engine.handleMessage("hello", emitter);
    await waitUntil(() => started.length === 2);
    expect(started).toEqual(["extract", "recall"]);

    extractDfd.resolve([{ question: "q", answer: "a" }]);
    recallDfd.resolve({ anchors: [], narratives: [], rounds: 1, sufficient: true });
    await run;

    expect(events.some((e) => e.type === "phase")).toBe(true);
    assertProtocolInvariants(events);
  });

  it("extract failure falls back to [] and still completes", async () => {
    process.env.REMI_CONVERSATION_FLOW_V2 = "observability-only";
    mockExtractAnchors.mockRejectedValue(new Error("extract failed"));

    const deps = createMockDeps();
    const engine = new InterviewEngine(deps);
    const { events, emitter } = createRecorderEmitter();

    await engine.handleMessage("hello", emitter);

    expect(deps.saveAnchors).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "done")).toBe(true);
    assertProtocolInvariants(events);
  });

  it("detect failure falls back to [] and still completes", async () => {
    process.env.REMI_CONVERSATION_FLOW_V2 = "observability-only";
    mockDetectContradictions.mockRejectedValue(new Error("detect failed"));

    const deps = createMockDeps();
    const engine = new InterviewEngine(deps);
    const { events, emitter } = createRecorderEmitter();

    await engine.handleMessage("hello", emitter);

    expect(events.some((e) => e.type === "done")).toBe(true);
    assertProtocolInvariants(events);
  });

  it("recall failure emits error and stops", async () => {
    process.env.REMI_CONVERSATION_FLOW_V2 = "full";
    mockAgenticRecall.mockRejectedValue(new Error("recall failed"));

    const deps = createMockDeps();
    const engine = new InterviewEngine(deps);
    const { events, emitter } = createRecorderEmitter();

    await engine.handleMessage("hello", emitter);

    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(false);
    assertProtocolInvariants(events);
  });

  it("falls back to non-stream chat when stream returns empty content", async () => {
    process.env.REMI_CONVERSATION_FLOW_V2 = "full";
    const chat = vi.fn().mockResolvedValue({
      content: "补偿回复",
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const chatStream = vi.fn().mockReturnValue(createEmptyStream());

    const deps = createMockDeps({
      chatClient: {
        chat,
        chatStream,
      },
      saveMessage: vi.fn().mockResolvedValue(42),
    });
    const engine = new InterviewEngine(deps);
    const { events, emitter } = createRecorderEmitter();

    await engine.handleMessage("hello", emitter);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "token" && e.data === "补偿回复")).toBe(true);
    expect(deps.saveMessage).toHaveBeenCalledWith("assistant", "补偿回复");
    expect(events.some((e) => e.type === "done")).toBe(true);
    assertProtocolInvariants(events);
  });

  it("emits error and does not save when fallback content is still empty", async () => {
    process.env.REMI_CONVERSATION_FLOW_V2 = "full";
    const chat = vi.fn().mockResolvedValue({
      content: "",
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const chatStream = vi.fn().mockReturnValue(createEmptyStream());

    const deps = createMockDeps({
      chatClient: {
        chat,
        chatStream,
      },
    });
    const engine = new InterviewEngine(deps);
    const { events, emitter } = createRecorderEmitter();

    await engine.handleMessage("hello", emitter);

    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(deps.saveMessage).toHaveBeenCalledTimes(1);
    expect(deps.saveMessage).toHaveBeenCalledWith("user", "hello");
    assertProtocolInvariants(events);
  });

  it("retries fallback chat without system role when provider rejects system", async () => {
    process.env.REMI_CONVERSATION_FLOW_V2 = "full";
    const chat = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'Chat API returned no choices: {"base_resp":{"status_code":2013,"status_msg":"invalid params, chat content has invalid message role: system"}}',
        ),
      )
      .mockResolvedValueOnce({
        content: "恢复成功",
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      });
    const chatStream = vi.fn().mockReturnValue(createEmptyStream());

    const deps = createMockDeps({
      getMessages: vi.fn().mockResolvedValue([
        { id: 1, role: "system", content: "legacy system", created_at: Date.now() },
        { id: 2, role: "user", content: "hello", created_at: Date.now() },
      ]),
      chatClient: {
        chat,
        chatStream,
      },
      saveMessage: vi.fn().mockResolvedValue(52),
    });
    const engine = new InterviewEngine(deps);
    const { events, emitter } = createRecorderEmitter();

    await engine.handleMessage("继续", emitter);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === "token" && e.data === "恢复成功")).toBe(true);
    expect(deps.saveMessage).toHaveBeenCalledWith("assistant", "恢复成功");
    expect(events.some((e) => e.type === "done")).toBe(true);
    assertProtocolInvariants(events);
  });

  it("inject failure=extract works in non-production", async () => {
    process.env.REMI_CONVERSATION_FLOW_V2 = "full";
    process.env.REMI_INJECT_INTERVIEW_FAILURE = "extract";
    process.env.NODE_ENV = "test";

    const deps = createMockDeps();
    const engine = new InterviewEngine(deps);
    const { events, emitter } = createRecorderEmitter();

    await engine.handleMessage("hello", emitter);

    expect(mockExtractAnchors).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "done")).toBe(true);
    assertProtocolInvariants(events);
  });

  it("inject failure=detect works in non-production", async () => {
    process.env.REMI_CONVERSATION_FLOW_V2 = "observability-only";
    process.env.REMI_INJECT_INTERVIEW_FAILURE = "detect";
    process.env.NODE_ENV = "test";

    const deps = createMockDeps();
    const engine = new InterviewEngine(deps);
    const { events, emitter } = createRecorderEmitter();

    await engine.handleMessage("hello", emitter);

    expect(mockDetectContradictions).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "done")).toBe(true);
    assertProtocolInvariants(events);
  });

  it("injection is ignored in production", async () => {
    process.env.REMI_CONVERSATION_FLOW_V2 = "full";
    process.env.REMI_INJECT_INTERVIEW_FAILURE = "extract";
    process.env.NODE_ENV = "production";

    const deps = createMockDeps();
    const engine = new InterviewEngine(deps);
    const { events, emitter } = createRecorderEmitter();

    await engine.handleMessage("hello", emitter);

    expect(mockExtractAnchors).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "done")).toBe(true);
    assertProtocolInvariants(events);
  });
});
