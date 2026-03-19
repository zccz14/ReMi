import { describe, it, expect, vi } from "vitest";
import { extractAnchors } from "../../src/interview/extractor.js";
import type { ChatClient } from "../../src/llm/client.js";

function mockChatClient(response: string): ChatClient {
  return {
    chat: vi.fn().mockResolvedValue({
      content: response,
      finishReason: "stop",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    }),
    chatStream: vi.fn(),
  };
}

describe("extractAnchors", () => {
  it("should extract anchors from LLM response", async () => {
    const client = mockChatClient(
      JSON.stringify({ anchors: [{ question: "你最看重什么价值观？", answer: "诚实和透明" }] }),
    );
    const result = await extractAnchors({
      chatClient: client,
      userMessage: "我觉得做人最重要的是诚实",
      recentMessages: [],
      existingAnchors: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0].question).toBe("你最看重什么价值观？");
    expect(result[0].answer).toBe("诚实和透明");
    expect(client.chat).toHaveBeenCalledTimes(1);
  });

  it("should return empty array on invalid JSON", async () => {
    const client = mockChatClient("这不是有效的 JSON");
    const result = await extractAnchors({
      chatClient: client,
      userMessage: "随便说点什么",
      recentMessages: [],
      existingAnchors: [],
    });
    expect(result).toEqual([]);
  });

  it("should return empty array on LLM error", async () => {
    const client: ChatClient = {
      chat: vi.fn().mockRejectedValue(new Error("LLM down")),
      chatStream: vi.fn(),
    };
    const result = await extractAnchors({
      chatClient: client,
      userMessage: "test",
      recentMessages: [],
      existingAnchors: [],
    });
    expect(result).toEqual([]);
  });
});
