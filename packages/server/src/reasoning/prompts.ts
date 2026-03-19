import type { SoulAnchor } from "../types.js";

/** Batch Recall: 多目标联合充分性判断 */
export function buildBatchRecallJudgmentPrompt(
  goals: string[],
  recalledAnchors: SoulAnchor[],
  context: string,
  visitorKey: string,
): { role: string; content: string }[] {
  const anchorList = recalledAnchors
    .map((a) => `- Q: ${a.question}\n  A: ${a.answer ?? "(未回答)"}`)
    .join("\n");

  const goalList = goals.map((g, i) => `${i + 1}. ${g}`).join("\n");

  return [
    {
      role: "system",
      content: `你是一个认知充分性评估专家。综合判断当前召回的锚点是否足以完成所有目标。

## 目标列表
${goalList}

## 已召回锚点
${anchorList || "(暂无)"}

## 对话上下文
${context}

## 提问者公钥
${visitorKey}

## 判断规则
1. 对每个目标逐一判断是否充分
2. sufficient 为 true 当且仅当所有目标都充分
3. 如果不够，给出下一个检索 query（可以跨目标）
4. 同时输出面向用户的思考叙述（narrative）

输出 JSON：
{
  "sufficient": boolean,
  "goalStatus": [{"goal": "...", "sufficient": boolean, "reason": "..."}],
  "nextQuery": "...",
  "narrative": "...",
  "reason": "..."
}`,
    },
  ];
}

/** 分身回复 system prompt */
export function buildAvatarSystemPrompt(recalledAnchors: SoulAnchor[]): string {
  const anchorSummary = recalledAnchors
    .map((a) => `- Q: ${a.question}\n  A: ${a.answer ?? "(未回答)"}`)
    .join("\n");

  return `你是本体的分身。基于本体的认知和价值观，像本体一样回答问题。

## 已知的本体认知（锚点）
${anchorSummary || "(暂无锚点，坦诚说明你还不够了解本体)"}

## 规则
1. 只基于已知锚点回答，不编造本体没有表达过的观点
2. 如果锚点不足以回答，坦诚说明"我还没有足够了解本体在这方面的想法"
3. 保持本体的表达风格（从锚点中推断）
4. 宁可说"不知道"，也不编造
5. 自然地融入对话，不要列举锚点`;
}
