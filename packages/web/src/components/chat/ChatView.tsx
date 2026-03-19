import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";
import type { ChatMessage, ChatPhase } from "../../hooks/use-chat";

interface ChatViewProps {
  messages: ChatMessage[];
  streaming: boolean;
  thinking: string | null;
  phase?: ChatPhase;
  thinkingItems?: string[];
  hasMore: boolean;
  onSend: (content: string) => void;
  onLoadMore: () => void;
  placeholder?: string;
}

export function ChatView({
  messages,
  streaming,
  thinking,
  phase,
  thinkingItems,
  hasMore,
  onSend,
  onLoadMore,
  placeholder,
}: ChatViewProps) {
  return (
    <div className="flex flex-col h-full">
      <MessageList
        messages={messages}
        thinking={thinking}
        phase={phase}
        thinkingItems={thinkingItems}
        hasMore={hasMore}
        onLoadMore={onLoadMore}
      />
      <ChatInput onSend={onSend} disabled={streaming} placeholder={placeholder} />
    </div>
  );
}
