import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { FullScreenLayout } from "../components/layout/FullScreenLayout";
import { ChatView } from "../components/chat/ChatView";
import { ChatAvatar } from "../components/chat/ChatAvatar";
import { useChat, type ChatConfig, type ChatMessage } from "../hooks/use-chat";
import { useAuth } from "../hooks/use-auth";

function truncatePubKey(pubKey: string): string {
  if (pubKey.length <= 13) return pubKey;
  return `${pubKey.slice(0, 6)}...${pubKey.slice(-4)}`;
}

export function AvatarChatPage() {
  const { t } = useTranslation();
  const { pubKey } = useParams<{ pubKey: string }>();
  const { apiClient, publicKey } = useAuth();
  const navigate = useNavigate();

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
      await apiClient.streamPost(
        path,
        { body_json: { type: "text", version: 1, text: content, entities: [] } },
        handlers,
      );
    },
  };

  const chat = useChat(config);

  const myAvatar = <ChatAvatar pubKey={publicKey} size="sm" />;
  const theirAvatar = (
    <ChatAvatar pubKey={pubKey ?? ""} size="sm" onClick={() => navigate(`/profile/${pubKey}`)} />
  );

  return (
    <FullScreenLayout title={truncatePubKey(pubKey ?? "")}>
      <ChatView
        messages={chat.messages}
        streaming={chat.streaming}
        thinking={chat.thinking}
        phase={chat.phase}
        thinkingItems={chat.thinkingItems}
        hasMore={chat.hasMore}
        onSend={chat.send}
        onLoadMore={chat.loadMore}
        placeholder={t("chat.placeholder")}
        myAvatar={myAvatar}
        theirAvatar={theirAvatar}
      />
    </FullScreenLayout>
  );
}
