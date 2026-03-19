import { useRef, useEffect } from "react";
import { MessageBubble } from "./MessageBubble";
import { ThinkingBlock } from "./ThinkingBlock";
import type { ChatMessage } from "../../hooks/use-chat";

interface MessageListProps {
  messages: ChatMessage[];
  thinking?: string | null;
  hasMore?: boolean;
  onLoadMore?: () => void;
}

export function MessageList({ messages, thinking, hasMore, onLoadMore }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking]);

  const handleScroll = () => {
    if (!containerRef.current || !hasMore || !onLoadMore) return;
    if (containerRef.current.scrollTop === 0) {
      onLoadMore();
    }
  };

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto p-4" onScroll={handleScroll}>
      {hasMore && (
        <button className="w-full text-center text-sm text-gray-400 py-2" onClick={onLoadMore}>
          Load earlier messages
        </button>
      )}
      {messages.map((msg) => (
        <MessageBubble key={msg.id} role={msg.role} content={msg.content} />
      ))}
      {thinking && <ThinkingBlock narrative={thinking} />}
      <div ref={bottomRef} />
    </div>
  );
}
