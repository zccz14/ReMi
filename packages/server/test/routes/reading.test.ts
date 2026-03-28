import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatClient } from "../../src/llm/client.js";
import { ConnectionManager } from "../../src/db/connection.js";
import { readingRoutes } from "../../src/routes/reading.js";

function createTestApp(connMgr: ConnectionManager, pubKey: string, chatClient: ChatClient | null) {
  const app = new Hono<{
    Variables: {
      signerPubKey: string;
      role: "owner" | "visitor";
      connMgr: ConnectionManager;
      chatClient: ChatClient | null;
    };
  }>();

  app.use("/api/:pubKey/*", async (c, next) => {
    c.set("signerPubKey", pubKey);
    c.set("role", pubKey === c.req.param("pubKey") ? "owner" : "visitor");
    c.set("connMgr", connMgr);
    c.set("chatClient", chatClient);
    await next();
  });

  app.route("/api", readingRoutes);
  return app;
}

describe("reading routes", () => {
  let tmpDir: string;
  let connMgr: ConnectionManager;
  const PUB_KEY = "testOwnerPubKey123";
  const longText = "我很看重长期关系里的信任，也会在有冲突时明确边界。".repeat(40);

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `remi-reading-route-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    connMgr = new ConnectionManager(tmpDir, { maxSize: 10, embeddingDimensions: 4 });
    connMgr.getConnection(PUB_KEY, { create: true });
  });

  afterEach(() => {
    connMgr.closeAll();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it("POST /api/:pubKey/reading/start returns LLM-generated round data", async () => {
    const chatClient: ChatClient = {
      chat: async () => ({
        content: [
          "<candidate><question>这段文本里，我在价值判断上最看重什么？</question><answer>我很看重长期关系里的信任。</answer><theme_id>value-judgments</theme_id><theme_label>价值观判断</theme_label><score>0.92</score><source_snippet>我很看重长期关系里的信任</source_snippet></candidate>",
          "<candidate><question>这段文本里，我处理冲突和边界时遵循什么原则？</question><answer>我会在冲突中明确边界。</answer><theme_id>conflict-handling</theme_id><theme_label>冲突处理</theme_label><score>0.88</score><source_snippet>也会在有冲突时明确边界</source_snippet></candidate>",
        ].join("\n"),
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
      chatStream: async function* () {
        yield "";
      },
    };

    const app = createTestApp(connMgr, PUB_KEY, chatClient);
    const res = await app.request(`/api/${PUB_KEY}/reading/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: longText, locale: "zh" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.items).toHaveLength(2);
    expect(json.data.items[0]).toEqual(
      expect.objectContaining({
        question: "这段文本里，我在价值判断上最看重什么？",
        answer: "我很看重长期关系里的信任。",
        themeId: "value-judgments",
        themeLabel: "价值观判断",
      }),
    );
  });

  it("POST /api/:pubKey/reading/start returns 500 when chat client is unavailable", async () => {
    const app = createTestApp(connMgr, PUB_KEY, null);
    const res = await app.request(`/api/${PUB_KEY}/reading/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: longText, locale: "zh" }),
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("LLM_ERROR");
  });
});
