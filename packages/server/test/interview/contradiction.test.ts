import { describe, it, expect, vi } from "vitest";
import { detectContradictions } from "../../src/interview/contradiction.js";
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

describe("detectContradictions", () => {
  it("should return contradictions from LLM", async () => {
    const client = mockChatClient(
      JSON.stringify({
        contradictions: [
          {
            newAnchor: "我喜欢独处",
            existingAnchor: "我是外向的人",
            description: "独处偏好与外向性格矛盾",
          },
        ],
      }),
    );
    const result = await detectContradictions({
      chatClient: client,
      newAnchors: [{ question: "你喜欢独处吗？", answer: "是的" }],
      existingAnchors: [
        {
          id: "1",
          question: "你的性格？",
          answer: "外向",
          source: "interview",
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].description).toContain("矛盾");
  });

  it("should return empty on no contradictions", async () => {
    const client = mockChatClient(JSON.stringify({ contradictions: [] }));
    const result = await detectContradictions({
      chatClient: client,
      newAnchors: [{ question: "q", answer: "a" }],
      existingAnchors: [],
    });
    expect(result).toEqual([]);
  });

  it("should return empty on LLM error", async () => {
    const client: ChatClient = {
      chat: vi.fn().mockRejectedValue(new Error("fail")),
      chatStream: vi.fn(),
    };
    const result = await detectContradictions({
      chatClient: client,
      newAnchors: [{ question: "q", answer: "a" }],
      existingAnchors: [],
    });
    expect(result).toEqual([]);
  });

  it("should skip if no new anchors", async () => {
    const client = mockChatClient("{}");
    const result = await detectContradictions({
      chatClient: client,
      newAnchors: [],
      existingAnchors: [],
    });
    expect(result).toEqual([]);
    expect(client.chat).not.toHaveBeenCalled();
  });
});
