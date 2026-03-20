import type { ReactNode } from "react";
import { useRef, useEffect } from "react";
import { MessageBubble } from "./MessageBubble";
import { ThinkingBlock } from "./ThinkingBlock";
import { ProcessPanel } from "./ProcessPanel";
import { Button } from "@/components/ui/button";
import type { ChatMessage, ChatPhase } from "../../hooks/use-chat";

interface MessageListProps {
  messages: ChatMessage[];
  thinking?: string | null;
  phase?: ChatPhase;
  thinkingItems?: string[];
  hasMore?: boolean;
  onLoadMore?: () => void;
  myAvatar?: ReactNode;
  theirAvatar?: ReactNode;
}

export function MessageList({
  messages,
  thinking,
  phase = "idle",
  thinkingItems = [],
  hasMore,
  onLoadMore,
  myAvatar,
  theirAvatar,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastMessageIdRef = useRef<number | null>(null);

  useEffect(() => {
    const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
    if (lastMessageId !== lastMessageIdRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    lastMessageIdRef.current = lastMessageId;
  }, [messages]);

  useEffect(() => {
    if (thinking || phase !== "idle" || thinkingItems.length > 0) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [thinking, phase, thinkingItems.length]);

  const handleScroll = () => {
    if (!containerRef.current || !hasMore || !onLoadMore) return;
    if (containerRef.current.scrollTop === 0) {
      onLoadMore();
    }
  };

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto p-4" onScroll={handleScroll}>
      {hasMore && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full text-muted-foreground"
          onClick={onLoadMore}
        >
          Load earlier messages
        </Button>
      )}
      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          role={msg.role}
          content={msg.content}
          avatar={msg.role === "user" ? myAvatar : theirAvatar}
        />
      ))}
      <ProcessPanel phase={phase} thinkingItems={thinkingItems} />
      {thinking && thinkingItems.length === 0 && <ThinkingBlock narrative={thinking} />}
      <div ref={bottomRef} />
    </div>
  );
}
