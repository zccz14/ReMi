import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useAuth } from "../hooks/use-auth";
import { ChatAvatar } from "../components/chat/ChatAvatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Conversation {
  type: "remi" | "avatar";
  pubKey?: string;
  lastMessage: string | null;
  lastMessageAt: number;
}

function truncatePubKey(pubKey: string): string {
  if (pubKey.length <= 13) return pubKey;
  return `${pubKey.slice(0, 6)}...${pubKey.slice(-4)}`;
}

function formatRelativeTime(ts: number, t: (key: string) => string): string {
  const now = Date.now();
  const date = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  if (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  ) {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    return "Yesterday";
  }

  return date.toLocaleDateString();
}

function ConversationSkeleton() {
  return (
    <div className="flex items-center gap-3 p-3">
      <Skeleton className="h-11 w-11 rounded-[10px] shrink-0" />
      <div className="flex-1 min-w-0 space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-40" />
      </div>
      <Skeleton className="h-3 w-10" />
    </div>
  );
}

export function MessagesPage() {
  const { t } = useTranslation();
  const { apiClient } = useAuth();
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient
      .get<{ data: Conversation[] }>(apiClient.ownerPath("/conversations"))
      .then((res) => setConversations(res.data))
      .catch(() => toast.error(t("common.error")))
      .finally(() => setLoading(false));
  }, [apiClient, t]);

  const handleClick = (item: Conversation) => {
    if (item.type === "remi") {
      navigate("/chat/remi");
    } else if (item.pubKey) {
      navigate(`/chat/${item.pubKey}`);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <h1 className="text-2xl font-bold p-4 pb-2">{t("messages.title")}</h1>

      {loading ? (
        <div className="space-y-1">
          {Array.from({ length: 4 }).map((_, i) => (
            <ConversationSkeleton key={i} />
          ))}
        </div>
      ) : conversations.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-4">
          <p className={cn("text-muted-foreground")}>{t("messages.empty")}</p>
          <Button onClick={() => navigate("/chat/remi")}>{t("messages.startChat")}</Button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {conversations.map((item, idx) => {
            const name = item.type === "remi" ? "ReMi" : truncatePubKey(item.pubKey ?? "");
            const avatarPubKey = item.type === "remi" ? "remi" : (item.pubKey ?? "");
            const preview = item.lastMessage ?? t("messages.tapToStart");

            return (
              <button
                key={item.type === "remi" ? "remi" : item.pubKey}
                type="button"
                className={cn(
                  "flex items-center gap-3 w-full text-left p-3 hover:bg-accent/50 active:bg-accent transition-colors",
                  idx < conversations.length - 1 && "border-b border-border",
                )}
                onClick={() => handleClick(item)}
              >
                <ChatAvatar
                  pubKey={avatarPubKey}
                  name={item.type === "remi" ? "ReMi" : undefined}
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">{name}</div>
                  <div
                    className={cn(
                      "text-xs truncate",
                      item.lastMessage ? "text-muted-foreground" : "text-muted-foreground/60",
                    )}
                  >
                    {preview}
                  </div>
                </div>
                {item.lastMessageAt > 0 && (
                  <div className="text-xs text-muted-foreground shrink-0">
                    {formatRelativeTime(item.lastMessageAt, t)}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
