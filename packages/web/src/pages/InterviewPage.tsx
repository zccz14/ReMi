import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ChatView } from "../components/chat/ChatView";
import { useChat, type ChatConfig, type ChatMessage } from "../hooks/use-chat";
import { useAuth } from "../hooks/use-auth";

export function InterviewPage() {
  const { t } = useTranslation();
  const { apiClient } = useAuth();
  const coldStartRef = useRef(false);

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
        toast.error(err.message ?? "Failed to start interview");
      });
  }, [chat.loaded, chat.messages.length]);

  return (
    <ChatView
      messages={chat.messages}
      streaming={chat.streaming}
      thinking={chat.thinking}
      hasMore={chat.hasMore}
      onSend={chat.send}
      onLoadMore={chat.loadMore}
      placeholder={t("chat.interviewPlaceholder")}
    />
  );
}
