import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChatView } from "../components/chat/ChatView";
import { useChat, type ChatConfig, type ChatMessage } from "../hooks/use-chat";
import { useAuth } from "../hooks/use-auth";

export function AvatarChatPage() {
  const { t } = useTranslation();
  const { pubKey } = useParams<{ pubKey: string }>();
  const { apiClient } = useAuth();

  const config: ChatConfig = {
    loadMessages: async (params) => {
      const query = new URLSearchParams();
      if (params.limit) query.set("limit", String(params.limit));
      if (params.before) query.set("before", String(params.before));
      const qs = query.toString();
      const path = `/api/${pubKey}/reasoning/messages${qs ? `?${qs}` : ""}`;
      const res = await apiClient.get<{ data: { items: ChatMessage[]; hasMore: boolean } }>(path);
      return res.data;
    },
    sendMessage: async (content, handlers) => {
      const path = `/api/${pubKey}/reasoning/message`;
      await apiClient.streamPost(path, { content }, handlers);
    },
  };

  const chat = useChat(config);

  return (
    <ChatView
      messages={chat.messages}
      streaming={chat.streaming}
      thinking={chat.thinking}
      hasMore={chat.hasMore}
      onSend={chat.send}
      onLoadMore={chat.loadMore}
      placeholder={t("chat.placeholder")}
    />
  );
}
