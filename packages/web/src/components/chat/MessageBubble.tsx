import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface MessageBubbleProps {
  role: "user" | "assistant" | "system";
  content: string;
  avatar?: ReactNode;
}

export function MessageBubble({ role, content, avatar }: MessageBubbleProps) {
  const isUser = role === "user";
  return (
    <div className={cn("flex mb-3 gap-2", isUser ? "justify-end" : "justify-start")}>
      {!isUser && avatar && <div className="shrink-0 self-end">{avatar}</div>}
      <div
        className={cn(
          "max-w-[70%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
        )}
      >
        {content}
      </div>
      {isUser && avatar && <div className="shrink-0 self-end">{avatar}</div>}
    </div>
  );
}
