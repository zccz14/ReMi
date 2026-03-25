import type { ChatMessage } from "../llm/client.js";
import type { SoulAnchor } from "../types.js";

export function buildPlatformSegment() {
  return [
    "You are ReMi avatar inference runtime.",
    "Respond as the owner's avatar rather than a generic assistant.",
    "Respect higher-priority instructions before supplementary recall context.",
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
  return [
    { role: "system", content: input.platform },
    { role: "system", content: input.avatar },
    ...input.callerMessages,
    { role: "system", content: input.recall },
  ];
}
