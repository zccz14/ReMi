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

  it("locks self-explanatory question boundaries to current-message evidence", () => {
    const messages = buildExtractionPrompt("我做决定时更看重长期空间，不太在意短期波动。", [], []);
    const system = messages[0]?.content ?? "";

    expect(system).toContain("自解释");
    expect(system).toContain("当前用户消息为准");
    expect(system).toContain("recentMessages");
    expect(system).toContain("仅可用于解析代词/省略");
    expect(system).toContain("不得新增当前消息未明确给出的事实、定义或判断");
  });

  it("requires first-person owner questions, de-identified examples, and no context-dependent references", () => {
    const messages = buildExtractionPrompt("我做决定时更看重长期空间，不太在意短期波动。", [], []);
    const system = messages[0]?.content ?? "";

    expect(system).toContain("必须使用“我”作为主语");
    expect(system).toContain("不得使用“用户”");
    expect(system).toContain("使用完全脱敏、虚构、不可回溯到真实用户的数据");
    expect(system).toContain("不得包含“这个”");
    expect(system).toContain("“那个”");
    expect(system).toContain("“刚才提到的”");
  });

  it("defines tri-state terminology anchors and message-level splitting rules", () => {
    const messages = buildExtractionPrompt(
      "上周二下午我去面试了一家创业公司，现在还在等结果。",
      [],
      [],
    );
    const system = messages[0]?.content ?? "";

    expect(system).toContain("required");
    expect(system).toContain("optional");
    expect(system).toContain("forbidden");
    expect(system).toContain("X 就是");
    expect(system).toContain("我说的 X 指的是");
    expect(system).toContain("解释性同位语");
    expect(system).toContain("释义短语");
    expect(system).toContain("独立判断/偏好/用途表达");
    expect(system).toContain("按消息级别拆分");
    expect(system).toContain("definition + judgment");
    expect(system).toContain("branching conditions");
    expect(system).toContain("不把短期时间词直接写入 question");
    expect(system).toContain("question 应锚定一个稳定信息槽位");
  });

  it("requires semantic object completion for terms and focused answers", () => {
    const messages = buildExtractionPrompt("我最近在做 ReMi，主要想把访谈记忆整理清楚。", [], []);
    const system = messages[0]?.content ?? "";

    expect(system).toContain("项目名/术语名/缩写/专有概念");
    expect(system).toContain("不得只保留裸术语名");
    expect(system).toContain("必须补足语义对象");
    expect(system).toContain("否则按术语定义锚点规则处理");
    expect(system).toContain("answer 保持短而聚焦");
    expect(system).toContain("不要用一个长 answer 覆盖多个条件分支、多个对象或多个术语解释");
    expect(system).toContain("该拆就拆");
  });

  it("only allows empty output when no new fact definition or judgment can be extracted", () => {
    const messages = buildExtractionPrompt("嗯。", [], []);
    const system = messages[0]?.content ?? "";

    expect(system).toContain("仅当当前消息没有新的事实、定义或判断可独立提取时");
    expect(system).toContain("不要输出任何 <anchor> 标签");
  });

  it("keeps the xml anchor output contract unchanged", () => {
    const messages = buildExtractionPrompt("我最近在准备考试。", [], []);
    const system = messages[0]?.content ?? "";

    expect(system).toContain(
      "<anchor><question>锚定问题</question><answer>用户的回答</answer></anchor>",
    );
  });
});
