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

  it("extracts multiple fact anchors from one dense message", async () => {
    const client = mockChatClient(
      `<anchor><question>我最近在忙什么？</question><answer>最近一边准备考试，一边做一个小工具，也在投简历。</answer></anchor>
<anchor><question>我现在在做什么项目？</question><answer>我在做一个小工具。</answer></anchor>
<anchor><question>我最近在推进哪些求职事项？</question><answer>我在投简历，也在准备考试。</answer></anchor>`,
    );

    const result = await extractAnchors({
      chatClient: client,
      userMessage: "我最近一边准备考试，一边在做一个小工具，也在投简历。",
      recentMessages: [],
      existingAnchors: [],
    });

    expect(result).toHaveLength(3);
  });

  it("keeps fact and cognition anchors side by side", async () => {
    const client = mockChatClient(
      `<anchor><question>我现在在做什么工作方式选择？</question><answer>我现在在做独立开发。</answer></anchor>
<anchor><question>我的协作偏好是什么样的？</question><answer>我不喜欢太重的团队协作流程。</answer></anchor>`,
    );

    const result = await extractAnchors({
      chatClient: client,
      userMessage: "我现在在做独立开发，因为我不喜欢太重的团队协作流程。",
      recentMessages: [],
      existingAnchors: [],
    });

    expect(result).toHaveLength(2);
  });

  it("keeps owner cognition questions in first person", async () => {
    const client = mockChatClient(
      `<anchor><question>用户的决策偏好是什么样的？</question><answer>我做决定时更看重长期空间，不太在意短期波动。</answer></anchor>`,
    );

    const result = await extractAnchors({
      chatClient: client,
      userMessage: "我做决定时更看重长期空间，不太在意短期波动。",
      recentMessages: [],
      existingAnchors: [],
    });

    expect(result[0]?.question).toBe("我的决策偏好是什么样的？");
    expect(result[0]?.question.includes("用户")).toBe(false);
  });

  it("accepts stable question wording for time-bound updates", async () => {
    const client = mockChatClient(
      `<anchor><question>我在上周二下午具体经历了什么求职进展？</question><answer>上周二下午我去面试了一家创业公司，现在还在等结果。</answer></anchor>`,
    );

    const result = await extractAnchors({
      chatClient: client,
      userMessage: "上周二下午我去面试了一家创业公司，现在还在等结果。",
      recentMessages: [],
      existingAnchors: [],
    });

    expect(result[0]?.question).toBe("我最近在经历什么求职进展？");
  });

  it("does not treat new lower-level facts as already covered", async () => {
    const client = mockChatClient(
      `<anchor><question>我最近在推进哪些求职事项？</question><answer>我最近主要在投后端岗位，也在准备系统设计面试。</answer></anchor>`,
    );

    const result = await extractAnchors({
      chatClient: client,
      userMessage: "我最近主要在投后端岗位，也在准备系统设计面试。",
      recentMessages: [],
      existingAnchors: [
        {
          id: "a1",
          question: "我最近在忙什么？",
          answer: "在找工作",
          source: "interview",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.question).toBe("我最近在推进哪些求职事项？");
  });

  it("returns empty array when the message adds no new information", async () => {
    const client = mockChatClient("没有新的可提取内容。");

    const result = await extractAnchors({
      chatClient: client,
      userMessage: "我最近在找工作。",
      recentMessages: [],
      existingAnchors: [
        {
          id: "a1",
          question: "我最近在忙什么？",
          answer: "我最近在找工作。",
          source: "interview",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    expect(result).toEqual([]);
  });
});
