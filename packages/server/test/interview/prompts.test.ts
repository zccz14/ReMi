import { describe, expect, it } from "vitest";
import { buildExtractionPrompt } from "../../src/interview/prompts.js";

describe("buildExtractionPrompt", () => {
  it("emphasizes fact-first recall", () => {
    const messages = buildExtractionPrompt(
      "我最近一边准备考试，一边在做一个小工具，也在投简历。",
      [],
      [],
    );
    const system = messages[0]?.content ?? "";

    expect(system).toContain("当前阶段以召回率优先");
    expect(system).toContain("优先提取用户明确说出的身份、事项、目标、事件、经历");
    expect(system).not.toContain("通用的、可复用的认知问题");
  });

  it("requires first-person owner questions and de-identified examples", () => {
    const messages = buildExtractionPrompt("我做决定时更看重长期空间，不太在意短期波动。", [], []);
    const system = messages[0]?.content ?? "";

    expect(system).toContain("必须使用“我”作为主语");
    expect(system).toContain("不得使用“用户”");
    expect(system).toContain("使用完全脱敏、虚构、不可回溯到真实用户的数据");
  });

  it("forbids short-lived context in question wording", () => {
    const messages = buildExtractionPrompt(
      "上周二下午我去面试了一家创业公司，现在还在等结果。",
      [],
      [],
    );
    const system = messages[0]?.content ?? "";

    expect(system).toContain("不把短期时间词直接写入 question");
    expect(system).toContain("question 应锚定一个稳定信息槽位");
  });
});
