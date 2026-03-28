import type { ChatMessage } from "../llm/client.js";
import type { SoulAnchor } from "../types.js";

export interface ReasoningAnswerGoal {
  id: string;
  goal: string;
  required: boolean;
}

export interface ReasoningGoalStatus {
  goalId: string;
  sufficient: boolean;
  known?: string[];
  missing?: string[];
  knownAnchorIds?: string[];
  missingKeys?: string[];
}

interface ReasoningDecompositionPromptInput {
  currentTime: string;
  userQuery: string;
}

interface ReasoningJudgmentPromptInput {
  currentTime: string;
  goals: ReasoningAnswerGoal[];
  anchors: SoulAnchor[];
  visitorKey?: string;
  visitorContext?: string;
}

interface ReasoningGenerationPromptInput {
  currentTime: string;
  userQuestion: string;
  answerGoals: ReasoningAnswerGoal[];
  evidenceAnchors: SoulAnchor[];
  goalStatus?: ReasoningGoalStatus[];
  missingInformation?: string[];
  reasoningChain?: string[];
  stoppedBecause?: string;
  temporalValiditySatisfied?: boolean;
}

function formatIsoTime(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function renderAnchorEvidence(anchor: SoulAnchor): string {
  return `- ID: ${anchor.id}\n  Q: ${anchor.question}\n  A: ${anchor.answer ?? "(未回答)"}\n  UpdatedAt: ${formatIsoTime(anchor.updatedAt)}`;
}

function renderGoal(goal: ReasoningAnswerGoal): string {
  return `- ${goal.id} [required=${goal.required ? "true" : "false"}]: ${goal.goal}`;
}

function renderGoalStatus(status: ReasoningGoalStatus): string {
  const known = status.known?.length ? status.known.join("；") : "(none)";
  const missing = status.missing?.length ? status.missing.join("；") : "(none)";
  const knownAnchorIds = status.knownAnchorIds?.length
    ? status.knownAnchorIds.join(", ")
    : "(none)";
  const missingKeys = status.missingKeys?.length ? status.missingKeys.join(", ") : "(none)";
  return `- GoalId: ${status.goalId}\n  Sufficient: ${status.sufficient ? "true" : "false"}\n  Known: ${known}\n  Missing: ${missing}\n  KnownAnchorIds: ${knownAnchorIds}\n  MissingKeys: ${missingKeys}`;
}

export function buildReasoningDecompositionPrompt(
  input: ReasoningDecompositionPromptInput,
): ChatMessage[] {
  return [
    {
      role: "system",
      content: `你是一个回答需求拆解助手。你的任务是只拆解回答目标，不直接回答用户问题。

## Current Time
${input.currentTime}

## Hard Rules
1. 输出必须是 JSON，不要输出 XML、Markdown code fence 或额外解释。
2. 必须返回 userQuery、currentTime、answerGoals、successCriteria。
3. answerGoals 中每一项都要包含 id、goal、required。
4. userQuery 必须回填原始用户问题；currentTime 必须回填当前时间。
5. reasoning 只能用于拆解信息需求，不能当作事实证据。`,
    },
    {
      role: "user",
      content: `请基于下面的原始用户问题拆解回答目标。

## Raw User Query
${input.userQuery}

请输出 JSON，格式示例：
{
  "userQuery": "${input.userQuery}",
  "currentTime": "${input.currentTime}",
  "answerGoals": [
    { "id": "identity_style", "goal": "...", "required": true }
  ],
  "successCriteria": ["..."]
}`,
    },
  ];
}

export function buildReasoningJudgmentPrompt(input: ReasoningJudgmentPromptInput): ChatMessage[] {
  return [
    {
      role: "system",
      content: `你是一个认知充分性评估专家。请评估当前锚点是否足以满足回答目标。

## Current Time
${input.currentTime}

## Hard Rules
1. 输出必须是 JSON，不要输出 XML。
2. 必须输出 sufficient、goalStatus、nextQuery、reasoningChain、narrative。
3. goalStatus 中每一项都必须包含 goalId、known、missing、sufficient、knownAnchorIds、missingKeys。
4. 如果 sufficient 为 true，nextQuery 必须为空字符串。
5. reasoningChain 只用于组织回答边界，不是事实证据，不能替代 anchor。
6. 结论是否充分要逐个 goal 判断，不能只给总体印象。`,
    },
    {
      role: "user",
      content: `请评估以下信息的充分性。

## Answer Goals
${input.goals.map(renderGoal).join("\n") || "(none)"}

## Evidence Anchors
${input.anchors.map(renderAnchorEvidence).join("\n") || "(暂无)"}

## Visitor Key
${input.visitorKey ?? "(none)"}

## Visitor Context
${input.visitorContext ?? "(none)"}

请输出 JSON，格式示例：
{
  "sufficient": false,
  "goalStatus": [
    {
      "goalId": "domain_answer",
      "known": ["..."],
      "missing": ["..."],
      "sufficient": false,
      "knownAnchorIds": ["a1"],
      "missingKeys": ["recent-position"]
    }
  ],
  "nextQuery": "...",
  "reasoningChain": ["..."],
  "narrative": "..."
}`,
    },
  ];
}

export function buildReasoningGenerationPrompt(input: ReasoningGenerationPromptInput): string {
  const goalSection = input.answerGoals.map(renderGoal).join("\n") || "(none)";
  const evidenceSection = input.evidenceAnchors.map(renderAnchorEvidence).join("\n") || "(暂无)";
  const missingSection = input.missingInformation?.length
    ? input.missingInformation.map((item) => `- ${item}`).join("\n")
    : "- (none)";
  const reasoningSection = [
    ...(input.goalStatus?.map(renderGoalStatus) ?? []),
    ...(input.stoppedBecause ? [`- StoppedBecause: ${input.stoppedBecause}`] : []),
    ...((input.reasoningChain?.length
      ? input.reasoningChain.map((item) => `- ${item}`)
      : ["- (none)"]) as string[]),
  ].join("\n");
  const temporalRule =
    input.temporalValiditySatisfied === false
      ? "5. temporal_validity 未满足时，必须使用保守措辞，例如“基于目前已知锚点”“我目前只知道”，并明确说明近期性不足。"
      : "5. 若时间有效性没有问题，也不要把推断包装成确定事实。";

  return `你是本体的分身。请基于证据回答，但保持边界感。

## Current Time
${input.currentTime}

## User Question
${input.userQuestion}

## Answer Goals
${goalSection}

## Evidence
${evidenceSection}

## Missing Information
${missingSection}

## Non-evidence Reasoning
${reasoningSection}

## Answering Rules
1. 只有 Evidence 里的 anchor 可以支撑 factual claim。
2. The reasoning chain is not factual evidence.
3. 如果某个 required goal 仍有缺口，必须明确承认不知道或说明边界。
4. 不要把 Non-evidence Reasoning 中的内容表述成已经确认的记忆、事实或立场。
${temporalRule}
6. 宁可明确说不知道，也不要编造。`;
}

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

## 判断规则
1. 对每个目标逐一判断是否充分
2. sufficient 为 true 当且仅当所有目标都充分
3. 如果不够，给出下一个检索 query（可以跨目标）
4. 同时输出面向用户的思考叙述（narrative）

输出格式：
<judgment>
<sufficient>true 或 false</sufficient>
<goal_status>
<goal>目标描述</goal><sufficient>true 或 false</sufficient><reason>理由</reason>
</goal_status>
<next_query>如果不充分，下一步检索的关键词</next_query>
<narrative>面向用户的思考叙述</narrative>
<reason>总体判断理由</reason>
</judgment>`,
    },
    {
      role: "user",
      content: `请评估以下信息的充分性。

## 目标列表
${goalList}

## 已召回锚点
${anchorList || "(暂无)"}

## 对话上下文
${context}

## 提问者公钥
${visitorKey}`,
    },
  ];
}

/** 分身回复 system prompt */
export function buildAvatarSystemPrompt(recalledAnchors: SoulAnchor[]): string {
  return buildReasoningGenerationPrompt({
    currentTime: new Date().toISOString(),
    userQuestion: "请基于已知锚点自然回答当前用户问题。",
    answerGoals: [
      {
        id: "domain_answer",
        goal: "只基于已知锚点回答当前问题，并在信息不足时明确说明边界",
        required: true,
      },
    ],
    evidenceAnchors: recalledAnchors,
    missingInformation:
      recalledAnchors.length > 0 ? [] : ["暂无锚点，需坦诚说明还不够了解本体在这方面的想法"],
    reasoningChain: ["保持本体表达风格，但不要把推断当成事实证据。"],
    temporalValiditySatisfied: true,
  });
}
