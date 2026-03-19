import { cn } from "@/lib/utils";

interface MessageBubbleProps {
  role: "user" | "assistant" | "system";
  content: string;
}

export function MessageBubble({ role, content }: MessageBubbleProps) {
  const isUser = role === "user";
  return (
    <div className={cn("flex mb-3", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
        )}
      >
        {content}
      </div>
    </div>
  );
}
