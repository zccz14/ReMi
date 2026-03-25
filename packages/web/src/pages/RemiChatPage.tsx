import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FullScreenLayout } from "../components/layout/FullScreenLayout";
import { ChatView } from "../components/chat/ChatView";
import { ChatAvatar } from "../components/chat/ChatAvatar";
import { useChat, type ChatConfig, type ChatMessage } from "../hooks/use-chat";
import { useAuth } from "../hooks/use-auth";
import { emptyPublicProfile, resolveProfileSummary } from "../lib/profile";

export function RemiChatPage() {
  const { t } = useTranslation();
  const { apiClient, publicKey } = useAuth();
  const coldStartRef = useRef(false);
  const [mySummary, setMySummary] = useState(() =>
    resolveProfileSummary(publicKey, emptyPublicProfile),
  );

  const config: ChatConfig = {
    loadMessages: async (params) => {
      const query = new URLSearchParams();
      if (params.limit) query.set("limit", String(params.limit));
      if (params.before) query.set("before", String(params.before));
      const qs = query.toString();
      const path = apiClient.ownerPath(`/interview/messages${qs ? `?${qs}` : ""}`);
      const res = await apiClient.get<{ data: { items: ChatMessage[]; hasMore: boolean } }>(path);
      return res.data;
    },
    sendMessage: async (content, handlers) => {
      const path = apiClient.ownerPath("/interview/message");
      await apiClient.streamPost(path, { content }, handlers);
    },
  };

  const chat = useChat(config);

  useEffect(() => {
    if (!chat.loaded || coldStartRef.current || chat.messages.length > 0 || chat.streaming) return;
    coldStartRef.current = true;
    const path = apiClient.ownerPath("/interview/start");
    apiClient
      .streamPost(
        path,
        {},
        {
          onDone: () => {
            chat.reload();
          },
        },
      )
      .catch((err: Error) => {
        coldStartRef.current = false;
        toast.error(err.message ?? "Failed to start interview");
      });
  }, [apiClient, chat.loaded, chat.messages.length, chat.reload, chat.streaming]);

  useEffect(() => {
    let active = true;

    setMySummary(resolveProfileSummary(publicKey, emptyPublicProfile));

    void apiClient
      .get<{ data: typeof emptyPublicProfile }>(apiClient.ownerPath("/profile"))
      .then((res) => {
        if (active) {
          setMySummary(resolveProfileSummary(publicKey, res.data ?? emptyPublicProfile));
        }
      })
      .catch(() => {
        if (active) {
          setMySummary(resolveProfileSummary(publicKey, emptyPublicProfile));
        }
      });

    return () => {
      active = false;
    };
  }, [apiClient, publicKey]);

  const myAvatar = (
    <ChatAvatar
      pubKey={publicKey}
      name={mySummary.displayName}
      src={mySummary.avatarUrl ?? undefined}
      size="sm"
    />
  );
  const theirAvatar = <ChatAvatar pubKey="remi" size="sm" />;

  return (
    <FullScreenLayout title="ReMi">
      <ChatView
        messages={chat.messages}
        streaming={chat.streaming}
        thinking={chat.thinking}
        phase={chat.phase}
        thinkingItems={chat.thinkingItems}
        hasMore={chat.hasMore}
        onSend={chat.send}
        onLoadMore={chat.loadMore}
        placeholder={t("chat.interviewPlaceholder")}
        myAvatar={myAvatar}
        theirAvatar={theirAvatar}
      />
    </FullScreenLayout>
  );
}
