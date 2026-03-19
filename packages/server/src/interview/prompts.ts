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
      content: `你是一个认知分析专家。分析用户的回答，提取灵魂锚点（核心问题与答案对）。

规则：
1. 每个锚点包含一个 question（锚定问题）和 answer（用户的回答）
2. question 应该是通用的、可复用的认知问题，不是对话中的原始提问
3. 不要重复提取已有锚点中已覆盖的内容
4. 如果没有新的可提取内容，返回空数组
5. 返回 JSON 数组格式

已有锚点：
${existingList || "(暂无)"}

输出格式：{"anchors": [{"question": "...", "answer": "..."}]}`,
    },
    ...recentMessages.slice(-4),
    { role: "user", content: userMessage },
  ];
}

/** Step 2: Agentic Recall 充分性判断 */
export function buildRecallJudgmentPrompt(
  recalledAnchors: SoulAnchor[],
  context: string,
  goal: string,
): { role: string; content: string }[] {
  const anchorList = recalledAnchors
    .map((a) => `Q: ${a.question}\nA: ${a.answer ?? "(未回答)"}`)
    .join("\n\n");

  return [
    {
      role: "system",
      content: `你是一个认知充分性评估专家。判断当前召回的锚点是否足以完成目标。

判断规则：
1. 如果锚点足以支撑目标，返回 sufficient: true
2. 如果不够，返回 sufficient: false 并给出新的检索 query
3. 同时输出一段面向用户的思考叙述（narrative），展示你的思考过程

输出 JSON：{"sufficient": boolean, "nextQuery": "...", "reason": "...", "narrative": "..."}`,
    },
    {
      role: "user",
      content: `请评估以下信息的充分性。

当前目标：${goal}

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
  return [
    {
      role: "system",
      content: `你是一个逻辑一致性检测专家。比较新提取的锚点与已有锚点，找出矛盾。

规则：
1. 只标记真正矛盾的内容，观点演变不算矛盾
2. 如果没有矛盾，返回空数组

输出 JSON：{"contradictions": [{"newAnchor": "...", "existingAnchor": "...", "description": "..."}]}`,
    },
    {
      role: "user",
      content: `请检测以下锚点间的矛盾。

新提取锚点：
${JSON.stringify(newAnchors, null, 2)}

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
