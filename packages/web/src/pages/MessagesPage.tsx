import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useAuth } from "../hooks/use-auth";
import { ChatAvatar } from "../components/chat/ChatAvatar";
import { loadPublicProfileSummary, type ResolvedProfileSummary } from "../lib/profile";
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

function formatRelativeTime(ts: number): string {
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
  const [profiles, setProfiles] = useState<Record<string, ResolvedProfileSummary>>({});

  useEffect(() => {
    let active = true;

    apiClient
      .get<{ data: Conversation[] }>(apiClient.ownerPath("/conversations"))
      .then((res) => {
        if (active) {
          setConversations(res.data);
        }
      })
      .catch(() => {
        if (active) {
          toast.error(t("common.error"));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [apiClient, t]);

  useEffect(() => {
    const pubKeys = [
      ...new Set(
        conversations
          .filter((item) => item.type === "avatar" && item.pubKey)
          .map((item) => item.pubKey as string),
      ),
    ];

    if (pubKeys.length === 0) {
      setProfiles({});
      return;
    }

    let active = true;

    void Promise.all(
      pubKeys.map(async (pubKey) => [pubKey, await loadPublicProfileSummary(pubKey)] as const),
    ).then((entries) => {
      if (active) {
        setProfiles(Object.fromEntries(entries));
      }
    });

    return () => {
      active = false;
    };
  }, [conversations]);

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
            const profile = item.pubKey ? profiles[item.pubKey] : null;
            const name =
              item.type === "remi"
                ? "ReMi"
                : (profile?.displayName ?? truncatePubKey(item.pubKey ?? ""));
            const avatarPubKey = item.type === "remi" ? "remi" : (item.pubKey ?? "");
            const avatarSrc =
              item.type === "avatar" ? (profile?.avatarUrl ?? undefined) : undefined;
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
                <ChatAvatar pubKey={avatarPubKey} name={name} src={avatarSrc} />
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
                    {formatRelativeTime(item.lastMessageAt)}
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
