import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "@remi/server/app";
import { buildStringToSign, generateKeyPair, getPublicKey, sign } from "@remi/crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Hono } from "hono";
import type {
  ChatClient,
  ChatMessage,
  ChatOptions,
  ChatResponse,
} from "../packages/server/src/llm/client.js";
import type { EmbeddingClient } from "../packages/server/src/embedding/client.js";

function createRecordingChatClient(options?: {
  responseText?: string;
  streamTokens?: string[];
  failChat?: boolean;
  failStream?: boolean;
  waitForFirstStreamToken?: Promise<void>;
}) {
  const recordedCalls: ChatMessage[][] = [];

  const client: ChatClient = {
    async chat(request: ChatOptions): Promise<ChatResponse> {
      recordedCalls.push(request.messages);
      if (options?.failChat) {
        throw new Error("upstream exploded");
      }

      return {
        content: options?.responseText ?? "avatar answer",
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },

    async *chatStream(request: ChatOptions) {
      recordedCalls.push(request.messages);
      if (options?.waitForFirstStreamToken) {
        await options.waitForFirstStreamToken;
      }
      if (options?.failStream) {
        throw new Error("upstream exploded");
      }

      for (const token of options?.streamTokens ?? ["avatar", " stream"]) {
        yield token;
      }
    },
  };

  return { client, recordedCalls };
}

function parseSseData(text: string) {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) =>
      block
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6)),
    )
    .flat();
}

function createRecallAwareEmbeddingClient() {
  let gate: Promise<void> | null = null;
  let failRecall = false;

  const client: EmbeddingClient = {
    async embed(texts: string[]) {
      if (gate) {
        await gate;
      }
      if (failRecall) {
        throw new Error("recall exploded");
      }
      return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
    },
  };

  return {
    client,
    blockRecall(nextGate: Promise<void>) {
      gate = nextGate;
    },
    failRecall() {
      failRecall = true;
    },
    clearRecallControls() {
      gate = null;
      failRecall = false;
    },
  };
}

describe("avatar openapi integration", () => {
  let tmpDir: string;
  let app: Hono;
  let cleanup: () => void;
  let ownerPrivKey: string;
  let ownerPubKey: string;

  async function signedOwnerRequest(method: string, urlPath: string, body?: string) {
    const timestamp = String(Date.now());
    const bodyBytes = body ? new TextEncoder().encode(body) : undefined;
    const pathname = urlPath.split("?")[0];
    const sts = await buildStringToSign(method, pathname, timestamp, bodyBytes);
    const signature = await sign(new TextEncoder().encode(sts), ownerPrivKey);

    const headers: Record<string, string> = {
      "X-Public-Key": ownerPubKey,
      "X-Timestamp": timestamp,
      "X-Signature": signature,
    };
    if (body) headers["Content-Type"] = "application/json";

    return app.request(urlPath, { method, headers, body: body ?? undefined });
  }

  async function createOwnerToken(note = "OpenAI local") {
    const res = await signedOwnerRequest(
      "POST",
      `/api/${ownerPubKey}/api-tokens`,
      JSON.stringify({ note }),
    );
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  }

  async function seedOwnerProfile() {
    const res = await signedOwnerRequest(
      "PUT",
      `/api/${ownerPubKey}/profile`,
      JSON.stringify({ displayName: "Test Owner", bio: "Builds careful execution plans." }),
    );
    expect(res.status).toBe(200);
  }

  async function seedOwnerAnchor(question: string, answer: string) {
    const res = await signedOwnerRequest(
      "POST",
      `/api/${ownerPubKey}/anchors`,
      JSON.stringify({ question, answer, source: "manual" }),
    );
    expect(res.status).toBe(201);
  }

  async function seedOwnerAnchors(count: number) {
    for (let index = 0; index < count; index += 1) {
      await seedOwnerAnchor(`Question ${index}`, `Answer ${index}`);
    }
  }

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `remi-avatar-openapi-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    ownerPrivKey = generateKeyPair();
    ownerPubKey = getPublicKey(ownerPrivKey);
  });

  afterEach(() => {
    cleanup?.();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("POST /ai/v1/chat/completions returns a minimal non-stream OpenAI completion", async () => {
    const recording = createRecordingChatClient({ responseText: "non-stream answer" });
    const result = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      chatClient: recording.client,
      embeddingClient: null,
    });
    app = result.app;
    cleanup = () => result.connMgr.closeAll();

    await signedOwnerRequest("GET", `/api/${ownerPubKey}/health`);
    const token = await createOwnerToken();

    const res = await app.request("/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.id}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: `ReMi-${ownerPubKey}`,
        messages: [{ role: "user", content: "Plan my day" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      object: "chat.completion",
      model: `ReMi-${ownerPubKey}`,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "non-stream answer" },
          finish_reason: "stop",
        },
      ],
    });
  });

  it("POST /ai/v1/chat/completions streams OpenAI-style SSE chunks", async () => {
    const recording = createRecordingChatClient({ streamTokens: ["hello", " world"] });
    const result = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      chatClient: recording.client,
      embeddingClient: null,
    });
    app = result.app;
    cleanup = () => result.connMgr.closeAll();

    await signedOwnerRequest("GET", `/api/${ownerPubKey}/health`);
    const token = await createOwnerToken();

    const res = await app.request("/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.id}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: `ReMi-${ownerPubKey}`,
        messages: [{ role: "user", content: "Stream please" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("chat.completion.chunk");
    expect(body).toContain("[DONE]");
    const dataBlocks = parseSseData(body).filter((value) => value !== "[DONE]");
    expect(dataBlocks.some((value) => value.includes("hello"))).toBe(true);
    expect(dataBlocks.some((value) => value.includes(" world"))).toBe(true);
  });

  it("POST /ai/v1/chat/completions rejects an invalid bearer token", async () => {
    const recording = createRecordingChatClient();
    const result = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      chatClient: recording.client,
      embeddingClient: null,
    });
    app = result.app;
    cleanup = () => result.connMgr.closeAll();

    await signedOwnerRequest("GET", `/api/${ownerPubKey}/health`);

    const res = await app.request("/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-invalid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: `ReMi-${ownerPubKey}`,
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "invalid_api_key" },
    });
  });

  it("POST /ai/v1/chat/completions rejects an invalid model", async () => {
    const recording = createRecordingChatClient();
    const result = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      chatClient: recording.client,
      embeddingClient: null,
    });
    app = result.app;
    cleanup = () => result.connMgr.closeAll();

    const res = await app.request("/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-invalid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "not-remi",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "invalid_model" },
    });
  });

  it("POST /ai/v1/chat/completions maps missing or empty model to invalid_model", async () => {
    const recording = createRecordingChatClient();
    const result = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      chatClient: recording.client,
      embeddingClient: null,
    });
    app = result.app;
    cleanup = () => result.connMgr.closeAll();

    for (const body of [
      {
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      },
      {
        model: "",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      },
      {
        model: 42,
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      },
    ]) {
      const res = await app.request("/ai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer sk-invalid",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "invalid_model" },
      });
    }
  });

  it("POST /ai/v1/chat/completions returns 404 when the target soul is missing", async () => {
    const missingPubKey = getPublicKey(generateKeyPair());
    const recording = createRecordingChatClient();
    const result = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      chatClient: recording.client,
      embeddingClient: null,
    });
    app = result.app;
    cleanup = () => result.connMgr.closeAll();

    const res = await app.request("/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-invalid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: `ReMi-${missingPubKey}`,
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "model_not_found" },
    });
  });

  it("POST /ai/v1/chat/completions ignores unsupported top-level fields", async () => {
    const recording = createRecordingChatClient();
    const result = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      chatClient: recording.client,
      embeddingClient: null,
    });
    app = result.app;
    cleanup = () => result.connMgr.closeAll();

    await signedOwnerRequest("GET", `/api/${ownerPubKey}/health`);
    const token = await createOwnerToken();

    const res = await app.request("/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.id}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: `ReMi-${ownerPubKey}`,
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
        temperature: 0,
        max_tokens: 256,
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      object: "chat.completion",
      choices: [
        {
          message: { role: "assistant", content: "avatar answer" },
          finish_reason: "stop",
        },
      ],
    });
  });

  it("POST /ai/v1/chat/completions maps upstream failures to upstream_model_error", async () => {
    const recording = createRecordingChatClient({ failChat: true });
    const result = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      chatClient: recording.client,
      embeddingClient: null,
    });
    app = result.app;
    cleanup = () => result.connMgr.closeAll();

    await signedOwnerRequest("GET", `/api/${ownerPubKey}/health`);
    const token = await createOwnerToken();

    const res = await app.request("/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.id}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: `ReMi-${ownerPubKey}`,
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "upstream_model_error" },
    });
  });

  it("POST /ai/v1/chat/completions keeps SSE open when the upstream stream fails before the first token", async () => {
    const recording = createRecordingChatClient({ failStream: true });
    const result = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      chatClient: recording.client,
      embeddingClient: null,
    });
    app = result.app;
    cleanup = () => result.connMgr.closeAll();

    await signedOwnerRequest("GET", `/api/${ownerPubKey}/health`);
    const token = await createOwnerToken();

    const res = await app.request("/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.id}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: `ReMi-${ownerPubKey}`,
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const body = await res.text();
    const chunks = parseSseData(body);

    expect(chunks).toHaveLength(3);
    expect(JSON.parse(chunks[0] ?? "{}")).toMatchObject({
      choices: [{ delta: { role: "assistant" }, finish_reason: null }],
    });
    await expect(JSON.parse(chunks[1] ?? "{}")).toMatchObject({
      error: { code: "upstream_model_error" },
    });
    expect(chunks[2]).toBe("[DONE]");
  });

  it("POST /ai/v1/chat/completions starts SSE before recall finishes", async () => {
    let releaseRecall!: () => void;
    const recallGate = new Promise<void>((resolve) => {
      releaseRecall = resolve;
    });
    const embedding = createRecallAwareEmbeddingClient();
    const recording = createRecordingChatClient({
      streamTokens: ["hello", " world"],
    });
    const result = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      chatClient: recording.client,
      embeddingClient: embedding.client,
    });
    app = result.app;
    cleanup = () => result.connMgr.closeAll();

    await signedOwnerRequest("GET", `/api/${ownerPubKey}/health`);
    await seedOwnerAnchors(21);
    const token = await createOwnerToken();
    embedding.blockRecall(recallGate);

    const resPromise = app.request("/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.id}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: `ReMi-${ownerPubKey}`,
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    });

    await expect(resPromise).resolves.toMatchObject({
      status: 200,
      headers: expect.objectContaining({}),
    });

    const res = await resPromise;
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    releaseRecall();

    const chunks = parseSseData(await res.text());
    expect(JSON.parse(chunks[0] ?? "{}")).toMatchObject({
      choices: [{ delta: { role: "assistant" }, finish_reason: null }],
    });
    expect(JSON.parse(chunks[1] ?? "{}")).toMatchObject({
      choices: [{ delta: { content: "hello" }, finish_reason: null }],
    });
  });

  it("POST /ai/v1/chat/completions reports recall failures in-stream after SSE starts", async () => {
    const embedding = createRecallAwareEmbeddingClient();
    const recording = createRecordingChatClient();
    const result = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      chatClient: recording.client,
      embeddingClient: embedding.client,
    });
    app = result.app;
    cleanup = () => result.connMgr.closeAll();

    await signedOwnerRequest("GET", `/api/${ownerPubKey}/health`);
    await seedOwnerAnchors(21);
    const token = await createOwnerToken();
    embedding.failRecall();

    const res = await app.request("/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.id}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: `ReMi-${ownerPubKey}`,
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const chunks = parseSseData(await res.text());

    expect(chunks).toHaveLength(3);
    expect(JSON.parse(chunks[0] ?? "{}")).toMatchObject({
      choices: [{ delta: { role: "assistant" }, finish_reason: null }],
    });
    expect(JSON.parse(chunks[1] ?? "{}")).toMatchObject({
      error: {
        code: "upstream_model_error",
        message: "recall exploded",
      },
    });
    expect(chunks[2]).toBe("[DONE]");
  });

  it("POST /ai/v1/chat/completions preserves platform avatar caller recall ordering", async () => {
    const recording = createRecordingChatClient({ responseText: "ordered answer" });
    const result = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      chatClient: recording.client,
      embeddingClient: null,
    });
    app = result.app;
    cleanup = () => result.connMgr.closeAll();

    await signedOwnerRequest("GET", `/api/${ownerPubKey}/health`);
    await seedOwnerProfile();
    await seedOwnerAnchor("Favorite workflow", "Plan first, then execute carefully.");
    const token = await createOwnerToken();

    const res = await app.request("/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.id}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: `ReMi-${ownerPubKey}`,
        messages: [
          { role: "system", content: "Caller system context" },
          { role: "assistant", content: "Earlier answer" },
          { role: "user", content: "caller message" },
        ],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    expect(recording.recordedCalls).toHaveLength(1);
    expect(recording.recordedCalls[0]?.map((message) => message.role)).toEqual([
      "system",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(recording.recordedCalls[0]?.map((message) => message.content)).toEqual([
      expect.stringContaining("ReMi avatar inference runtime."),
      "Earlier answer",
      "caller message",
      expect.stringContaining("Favorite workflow"),
    ]);

    expect(recording.recordedCalls[0]?.[0]?.content).toContain(ownerPubKey);
    expect(recording.recordedCalls[0]?.[0]?.content).toContain("Avatar identity:");
    expect(recording.recordedCalls[0]?.[0]?.content).toContain("Caller system context");
  });
});
