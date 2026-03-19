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
  it("should extract anchors from XML response", async () => {
    const client = mockChatClient(
      `分析用户回答后提取到以下锚点：
<anchor><question>你最看重什么价值观？</question><answer>诚实和透明</answer></anchor>`,
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

  it("should extract multiple anchors", async () => {
    const client = mockChatClient(
      `<anchor><question>做人最重要的品质？</question><answer>诚实</answer></anchor>
<anchor><question>什么场合都要保持的态度？</question><answer>表里如一</answer></anchor>`,
    );
    const result = await extractAnchors({
      chatClient: client,
      userMessage: "诚实坦率，表里如一",
      recentMessages: [],
      existingAnchors: [],
    });
    expect(result).toHaveLength(2);
  });

  it("should return empty array when no XML tags found", async () => {
    const client = mockChatClient("用户的回答没有包含新的认知信息，无需提取锚点。");
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

  it("should skip anchors with missing question or answer", async () => {
    const client = mockChatClient(
      `<anchor><question>完整的问题</question><answer>完整的答案</answer></anchor>
<anchor><question>只有问题</question></anchor>`,
    );
    const result = await extractAnchors({
      chatClient: client,
      userMessage: "test",
      recentMessages: [],
      existingAnchors: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0].question).toBe("完整的问题");
  });
});
