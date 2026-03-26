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
    expect(system).toContain("当需要区分槽位、避免歧义或术语裸奔时");
    expect(system).toContain("必须补足边界要素");
    expect(system).toContain("语境范围");
    expect(system).toContain("成立条件");
    expect(system).toContain("术语语义");
    expect(system).toContain("天然自解释的简单事实问题");
    expect(system).toContain("不要求为了满足格式去臆造范围/条件/术语语义");
    expect(system).toContain("稳定可复用");
    expect(system).toContain("不能机械复述当前消息原话");
    expect(system).toContain("不能退化成对当前一句话的机械转写");
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
    expect(system).toContain("这里的 X 不是……而是……");
    expect(system).toContain("解释性同位语");
    expect(system).toContain("释义短语");
    expect(system).toContain("独立判断/偏好/用途表达");
    expect(system).toContain("按消息级别拆分");
    expect(system).toContain("definition + judgment");
    expect(system).toContain("branching conditions");
    expect(system).toContain("显式定义句式");
    expect(system).toContain("必须额外生成 1 条术语定义锚点");
    expect(system).toContain("同一术语在单条消息中最多新增 1 条术语定义锚点");
    expect(system).toContain("必须拆成 definition anchor + judgment anchor");
  });

  it("lets question carry scope conditions and discussion objects when needed for self-explanation", () => {
    const messages = buildExtractionPrompt(
      "只有在高压项目里，我才会把速度放在稳定性前面。",
      [],
      [],
    );
    const system = messages[0]?.content ?? "";

    expect(system).toContain("question 优先承载语境范围、成立条件、讨论对象");
    expect(system).toContain("只有纯临时、不可复用的时间细节");
    expect(system).toContain("不要机械写进 question");
    expect(system).toContain("当条件/范围是区分槽位、保证自解释所必需时，可以进入 question");
  });

  it("covers spec examples for scope term definitions and branching contracts", () => {
    const messages = buildExtractionPrompt(
      "如果信息不完整，我会先自己补齐；但如果这是高压力且独立开发的项目，我会先保守推进 ReMi。我说的 ReMi 指的是我的访谈记忆整理项目。XTP 先不展开。",
      [],
      [],
    );
    const system = messages[0]?.content ?? "";

    expect(system).toContain("高压力");
    expect(system).toContain("信息不完整");
    expect(system).toContain("独立开发");
    expect(system).toContain("ReMi");
    expect(system).toContain("definition anchor + judgment anchor");
    expect(system).toContain("如果…；但如果…");
    expect(system).toContain("XTP");
    expect(system).toContain("不得生成定义锚点");
  });

  it("defines split boundaries without forcing oversplitting or fake boundaries", () => {
    const messages = buildExtractionPrompt(
      "我独立开发时，如果信息不完整会先补齐；另外我昨天其实只是顺手提了一句背景。",
      [],
      [],
    );
    const system = messages[0]?.content ?? "";

    expect(system).toContain("不拆分");
    expect(system).toContain("同义补充");
    expect(system).toContain("修辞重复");
    expect(system).toContain("纯背景铺垫");
    expect(system).toContain("删去子句后主判断不变");
    expect(system).toContain("可拆但非必须");
    expect(system).toContain("围绕同一对象的并列细节");
    expect(system).toContain("可独立召回的简洁释义");
    expect(system).toContain("不是把一句话切得越碎越好");
    expect(system).toContain("天然自解释的简单事实问题");
    expect(system).toContain("不要求为了满足格式去臆造范围/条件/术语语义");
  });

  it("requires semantic object completion for terms and focused answers", () => {
    const messages = buildExtractionPrompt("我最近在做 ReMi，主要想把访谈记忆整理清楚。", [], []);
    const system = messages[0]?.content ?? "";

    expect(system).toContain("项目名/术语名/缩写/专有概念");
    expect(system).toContain("不得只保留裸术语名");
    expect(system).toContain("必须补足语义对象");
    expect(system).toContain("或额外生成术语定义锚点");
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
