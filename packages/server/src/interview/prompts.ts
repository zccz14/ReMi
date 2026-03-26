import type { SoulAnchor } from "../types.js";

/** Step 1: 从用户回答中提取灵魂锚点 */
export function buildExtractionPrompt(
  userMessage: string,
  recentMessages: { role: string; content: string }[],
  existingAnchors: SoulAnchor[],
): { role: string; content: string }[] {
  const existingList = existingAnchors
    .map((a) => `Q: ${a.question}\nA: ${a.answer ?? "(未回答)"}`)
    .join("\n\n");

  return [
    {
      role: "system",
      content: `你是一个认知分析专家。分析用户的回答，提取灵魂锚点（核心问题与答案对）。当前阶段以召回率优先，宁可多记，后续再归并，不要因为追求抽象和精炼而漏掉明确事实。

规则：
1. 每个锚点包含一个 question（锚定问题）和 answer（用户的回答）
  2. question 必须是脱离当前对话上下文也能成立的自解释问题，明确写出边界信息，而不是宽泛槽位；每条值得提取的 question 至少显式包含一个边界要素（语境范围 / 成立条件 / 术语语义），如果三者都没有、只剩宽泛槽位名，就不合格；可以是事实问题，也可以是认知问题
 3. 当前用户消息为准；recentMessages 仅可用于解析代词/省略，不得新增当前消息未明确给出的事实、定义或判断，也不能依赖模型先验、常识脑补或外部信息
 4. 优先提取用户明确说出的身份、事项、目标、事件、经历、关系、地点、时间线与动机
  5. 如果 question 出现项目名/术语名/缩写/专有概念，主 question 必须补足语义对象与术语语义，或额外生成术语定义锚点；例如 ReMi 不能只保留裸术语名；无论哪种情况都不得只保留裸术语名
  6. 如果一条消息中有多个独立信息点，应尽量分别提取；事实锚点与认知锚点可以并存。definition + judgment、branching conditions（如“如果…；但如果…”、“如果信息不完整；但如果是高压力且独立开发”）必须按消息级别拆分，不要跨消息合并成一个 question
  7. 只跳过与已有锚点明显等价的重复内容；信息粒度不同、背景补充、状态更新都不算重复
  8. 凡是锚定本体的人格、认知、偏好、经历与事实，question 必须使用“我”作为主语，不得使用“用户”
  9. question 优先承载语境范围、成立条件、讨论对象，以保证槽位自解释；例如“高压力”“信息不完整”“独立开发”这类范围/条件在需要区分槽位时应进入 question；只有纯临时、不可复用的时间细节不要机械写进 question
  10. 当条件/范围是区分槽位、保证自解释所必需时，可以进入 question
  11. question 不得包含“这个”“那个”“刚才提到的”等依赖上下文才能解析的指代
  12. 涉及术语定义锚点时，必须按以下规则判断：required：出现显式定义句式，如“X 就是…”、“我说的 X 指的是…”、“这里的 X 不是……而是……”，并且必须额外生成 1 条术语定义锚点；为避免过拆，同一术语在单条消息中最多新增 1 条术语定义锚点；若同条消息还有 judgment，必须拆成 definition anchor + judgment anchor；optional：存在解释性同位语或释义短语，且同一条消息内还有针对该术语对象的独立判断/偏好/用途表达；forbidden：无定义句式且无解释性同位语/释义短语，例如陌生缩写 XTP 在没有定义证据时不得生成定义锚点
  13. answer 保持短而聚焦，不要用一个长 answer 覆盖多个条件分支、多个对象或多个术语解释；该拆就拆
  14. 如果 prompt 中需要示例，只能使用完全脱敏、虚构、不可回溯到真实用户的数据
  15. 仅当当前消息没有新的事实、定义或判断可独立提取时，不要输出任何 <anchor> 标签

已有锚点：
${existingList || "(暂无)"}

输出格式（每个锚点一个 <anchor> 标签）：
<anchor><question>锚定问题</question><answer>用户的回答</answer></anchor>`,
    },
    ...recentMessages.slice(-4),
    { role: "user", content: userMessage },
  ];
}

/** Step 2: Agentic Recall 充分性判断 */
export function buildRecallJudgmentPrompt(
  recalledAnchors: SoulAnchor[],
  context: string,
  goals: string[],
): { role: string; content: string }[] {
  const anchorList = recalledAnchors
    .map((a) => `Q: ${a.question}\nA: ${a.answer ?? "(未回答)"}`)
    .join("\n\n");

  return [
    {
      role: "system",
      content: `你是一个认知充分性评估专家。判断当前召回的锚点是否足以完成目标。

判断规则：
1. 如果锚点足以支撑目标，sufficient 为 true
2. 如果不够，sufficient 为 false 并给出新的检索 query
3. 同时输出一段面向用户的思考叙述（narrative），展示你的思考过程

输出格式：
<judgment>
<sufficient>true 或 false</sufficient>
<next_query>如果不充分，下一步检索的关键词</next_query>
<reason>判断理由</reason>
<narrative>面向用户的思考叙述</narrative>
</judgment>`,
    },
    {
      role: "user",
      content: `请评估以下信息的充分性。

目标列表：
${goals.map((goal, index) => `${index + 1}. ${goal}`).join("\n")}

已召回锚点：
${anchorList || "(暂无)"}

对话上下文：
${context}`,
    },
  ];
}

/** Step 3: 矛盾检测 */
export function buildContradictionPrompt(
  newAnchors: { question: string; answer: string }[],
  existingAnchors: SoulAnchor[],
): { role: string; content: string }[] {
  const newList = newAnchors.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n");

  return [
    {
      role: "system",
      content: `你是一个逻辑一致性检测专家。比较新提取的锚点与已有锚点，找出矛盾。

规则：
1. 只标记真正矛盾的内容，观点演变不算矛盾
2. 如果没有矛盾，不要输出任何 <contradiction> 标签

输出格式（每个矛盾一个 <contradiction> 标签）：
<contradiction>
<new_anchor>新锚点的内容摘要</new_anchor>
<existing_anchor>已有锚点的内容摘要</existing_anchor>
<description>矛盾描述</description>
</contradiction>`,
    },
    {
      role: "user",
      content: `请检测以下锚点间的矛盾。

新提取锚点：
${newList}

已有锚点：
${existingAnchors.map((a) => `Q: ${a.question}\nA: ${a.answer ?? "(未回答)"}`).join("\n\n") || "(暂无)"}`,
    },
  ];
}

/** Step 4: 访谈主持人系统 prompt */
export function buildInterviewerSystemPrompt(
  recalledAnchors: SoulAnchor[],
  contradictions: { newAnchor: string; existingAnchor: string; description: string }[],
  totalAnchors: number,
): string {
  const anchorSummary = recalledAnchors
    .map((a) => `- ${a.question}: ${a.answer ?? "(未回答)"}`)
    .join("\n");

  const contradictionNote =
    contradictions.length > 0
      ? `\n\n## 发现的矛盾（优先追问）\n${contradictions.map((c) => `- ${c.description}`).join("\n")}`
      : "";

  return `你是 ReMi 的 AI 访谈主持人。你的使命是通过结构化访谈，深度挖掘本体的隐含知识。

## 已知灵魂锚点（${totalAnchors} 个）
${anchorSummary || "(暂无，这是第一次对话)"}
${contradictionNote}

## 访谈协议
1. **三步提问**：先轻量 → 再求新 → 最后具体
2. **状态感知**：识别受访者状态（愿意聊/防御/疲劳/跑题），调整风格
3. **不问已知**：已有锚点覆盖的内容不重复追问
4. **始终探索**：每次回复必须包含一个新问题

## 输出要求
先自然地回应用户的上一条消息，然后提出新问题。保持对话流畅自然。`;
}
