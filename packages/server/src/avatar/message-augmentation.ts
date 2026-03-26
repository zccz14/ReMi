import type { ChatMessage } from "../llm/client.js";
import type { SoulAnchor } from "../types.js";

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

export function buildRecallSegment(anchors: SoulAnchor[]) {
  const lines = anchors.map(
    (anchor) => `- Q: ${anchor.question}\n  A: ${anchor.answer ?? "(未回答)"}`,
  );

  return [
    "Supplementary recalled anchors (lower priority than platform, avatar, and caller context):",
    lines.join("\n") || "(暂无可用召回锚点)",
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
