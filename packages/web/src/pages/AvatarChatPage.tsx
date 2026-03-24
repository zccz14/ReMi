import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { FullScreenLayout } from "../components/layout/FullScreenLayout";
import { ChatView } from "../components/chat/ChatView";
import { ChatAvatar } from "../components/chat/ChatAvatar";
import { useChat, type ChatConfig, type ChatMessage } from "../hooks/use-chat";
import { useAuth } from "../hooks/use-auth";
import {
  emptyPublicProfile,
  loadPublicProfileSummary,
  resolveProfileSummary,
} from "../lib/profile";

interface AvatarChatPageContentProps {
  pubKey: string;
  publicKey: string;
  apiClient: ReturnType<typeof useAuth>["apiClient"];
  counterpartName: string;
  counterpartAvatarUrl: string | null;
  navigateToProfile: () => void;
  placeholder: string;
}

function AvatarChatPageContent({
  pubKey,
  publicKey,
  apiClient,
  counterpartName,
  counterpartAvatarUrl,
  navigateToProfile,
  placeholder,
}: AvatarChatPageContentProps) {
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
    <ChatAvatar
      pubKey={pubKey}
      name={counterpartName}
      src={counterpartAvatarUrl ?? undefined}
      size="sm"
      onClick={navigateToProfile}
    />
  );

  return (
    <ChatView
      messages={chat.messages}
      streaming={chat.streaming}
      thinking={chat.thinking}
      phase={chat.phase}
      thinkingItems={chat.thinkingItems}
      hasMore={chat.hasMore}
      onSend={chat.send}
      onLoadMore={chat.loadMore}
      placeholder={placeholder}
      myAvatar={myAvatar}
      theirAvatar={theirAvatar}
    />
  );
}

export function AvatarChatPage() {
  const { t } = useTranslation();
  const { pubKey } = useParams<{ pubKey: string }>();
  const { apiClient, publicKey } = useAuth();
  const navigate = useNavigate();
  const [loadedSummary, setLoadedSummary] = useState(() =>
    resolveProfileSummary(pubKey ?? "", emptyPublicProfile),
  );
  const activePubKey = pubKey ?? "";
  const summary =
    loadedSummary.pubKey === activePubKey
      ? loadedSummary
      : resolveProfileSummary(activePubKey, emptyPublicProfile);

  useEffect(() => {
    setLoadedSummary(resolveProfileSummary(activePubKey, emptyPublicProfile));

    if (!pubKey) {
      return;
    }

    let active = true;

    void loadPublicProfileSummary(pubKey).then((nextSummary) => {
      if (active) {
        setLoadedSummary(nextSummary);
      }
    });

    return () => {
      active = false;
    };
  }, [activePubKey, pubKey]);

  const title = useMemo(
    () => (
      <div className="flex items-center justify-center gap-2 px-2 py-1 min-w-0">
        <ChatAvatar
          pubKey={activePubKey}
          name={summary.displayName}
          src={summary.avatarUrl ?? undefined}
          size="sm"
          onClick={() => navigate(`/profile/${pubKey}`)}
        />
        <span className="truncate">{summary.displayName}</span>
      </div>
    ),
    [activePubKey, navigate, pubKey, summary.avatarUrl, summary.displayName],
  );

  return (
    <FullScreenLayout title={title}>
      <AvatarChatPageContent
        key={activePubKey}
        pubKey={activePubKey}
        publicKey={publicKey}
        apiClient={apiClient}
        counterpartName={summary.displayName}
        counterpartAvatarUrl={summary.avatarUrl}
        navigateToProfile={() => navigate(`/profile/${pubKey}`)}
        placeholder={t("chat.placeholder")}
      />
    </FullScreenLayout>
  );
}
