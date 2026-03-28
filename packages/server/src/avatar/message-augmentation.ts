import type { ChatMessage } from "../llm/client.js";
import type { SoulAnchor } from "../types.js";

const MISSING_INFORMATION_SUMMARIES: Record<string, string> = {
  "identity-unknown": "我还缺少足够的身份信息来稳妥回答。",
  "style-unknown": "我还缺少足够的表达风格信息来稳妥回答。",
  "visitor-relationship": "我还不够确定与提问者的关系背景。",
  "visitor-boundary": "我还不够确定与提问者之间的沟通边界。",
  "domain-fact-missing": "回答这个问题还缺少关键事实依据。",
  "domain-preference-missing": "回答这个问题还缺少相关偏好信息。",
  "recent-position": "缺少更近期更新。",
  "time-validity-uncertain": "相关信息的时间有效性还不够确定。",
  "unassessed-required-goal": "仍有必需目标没有完成充分性判断。",
  other: "还有一些关键信息缺口尚未明确。",
};

const STOP_REASON_SUMMARIES: Record<string, string> = {
  sufficient: "当前召回信息已经足够支撑回答。",
  "no-new-anchors": "没有找到新的可用锚点。",
  "no-missing-reduced": "继续扩展召回也没有缩小现有信息缺口。",
  "empty-next-query": "下一步检索方向已经不再明确。",
  "parse-failure": "本轮充分性判断未能稳定完成。",
  "max-rounds": "已达到本轮召回尝试上限。",
};

function formatIsoTime(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

export function buildPlatformSegment() {
  return [
    "You are ReMi avatar inference runtime.",
    "Respond as the owner's avatar rather than a generic assistant.",
    "Respect higher-priority instructions before supplementary recall context.",
    "Do not jump into reasoning before understanding the caller's environment when it materially affects the answer.",
    "Caller environment includes current task, constraints, and relationship; investigate missing goals, constraints, permissions, time, or relationship boundaries only when they materially affect the answer.",
    "Ask the minimum necessary questions before environment-dependent advice, plans, judgments, or risk calls.",
    "low-risk or environment-independent requests can be answered directly.",
    "Use existing context and avoid repeated questioning when it is already sufficient.",
    "If incomplete context still requires a temporary judgment, keep it conditional and state assumptions explicitly.",
  ].join("\n");
}

export function buildAvatarIdentitySegment(input: {
  publicKey: string;
  displayName?: string;
  bio?: string;
}) {
  return [
    "Avatar identity:",
    `- public key: ${input.publicKey}`,
    `- display name: ${input.displayName?.trim() || "(not set)"}`,
    `- bio: ${input.bio?.trim() || "(not set)"}`,
  ].join("\n");
}

export function buildRecallSegment(input: {
  anchors: SoulAnchor[];
  missingInformation?: string[];
  stoppedBecause?: string;
}) {
  const evidenceLines = input.anchors.map(
    (anchor) =>
      `- Q: ${anchor.question}\n  A: ${anchor.answer ?? "(未回答)"}\n  UpdatedAt: ${formatIsoTime(anchor.updatedAt)}`,
  );
  const summarizeMissingInformation = (item: string) => MISSING_INFORMATION_SUMMARIES[item] ?? item;
  const missingInformation = Array.from(
    new Set((input.missingInformation ?? []).map(summarizeMissingInformation).filter(Boolean)),
  );
  const missingLines = input.missingInformation?.length
    ? missingInformation.map((item) => `- ${item}`).join("\n")
    : "- (none)";
  const reasoningLines = input.stoppedBecause
    ? [`- ${STOP_REASON_SUMMARIES[input.stoppedBecause] ?? "本轮召回在边界条件下提前结束。"}`]
    : ["- (none)"];

  return [
    "Supplementary recalled anchors (lower priority than platform, avatar, and caller context):",
    "## Evidence",
    evidenceLines.join("\n") || "(暂无可用召回锚点)",
    "## Missing Information",
    missingLines,
    "## Non-evidence Reasoning",
    reasoningLines.join("\n"),
  ].join("\n\n");
}

export function buildDownstreamMessages(input: {
  platform: string;
  avatar: string;
  callerMessages: ChatMessage[];
  recall: string;
}): ChatMessage[] {
  const callerSystem = input.callerMessages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");
  const callerMessages = input.callerMessages.filter((message) => message.role !== "system");
  const mergedSystem = [input.platform, input.avatar, callerSystem].filter(Boolean).join("\n\n");

  return [
    { role: "system", content: mergedSystem },
    ...callerMessages,
    { role: "assistant", content: input.recall },
  ];
}
