import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { type SSEHandlers } from "../lib/sse-client";

export interface ChatMessage {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: number;
}

export interface ChatConfig {
  loadMessages: (params: {
    limit?: number;
    before?: number;
  }) => Promise<{ items: ChatMessage[]; hasMore: boolean }>;
  sendMessage: (content: string, handlers: SSEHandlers) => Promise<void>;
}

export function useChat(config: ChatConfig) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [thinking, setThinking] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    const result = await config.loadMessages({ limit: 50 });
    setMessages(result.items);
    setHasMore(result.hasMore);
    setLoaded(true);
  }, [config]);

  useEffect(() => {
    reload();
  }, []);

  const loadMore = useCallback(async () => {
    if (messages.length === 0 || !hasMore) return;
    const oldest = messages[0];
    const result = await config.loadMessages({
      limit: 50,
      before: oldest.id,
    });
    setMessages((prev) => [...result.items, ...prev]);
    setHasMore(result.hasMore);
  }, [messages, hasMore, config]);

  const send = useCallback(
    (content: string) => {
      if (streaming) return;

      const userMsg: ChatMessage = {
        id: -Date.now(),
        role: "user",
        content,
        created_at: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setStreaming(true);
      setThinking(null);
      setError(null);

      let assistantContent = "";
      const assistantId = -(Date.now() + 1);

      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant" as const, content: "", created_at: Date.now() },
      ]);

      config
        .sendMessage(content, {
          onThinking: (narrative) => setThinking(narrative),
          onToken: (token) => {
            assistantContent += token;
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: assistantContent } : m)),
            );
          },
          onDone: (data) => {
            const msgId = (data as { messageId?: number }).messageId;
            if (msgId) {
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, id: msgId } : m)),
              );
            }
            setStreaming(false);
            setThinking(null);
          },
          onError: (err) => {
            setError(err.message);
            toast.error(err.message);
            setStreaming(false);
            setThinking(null);
          },
        })
        .catch((err: Error) => {
          const msg = err.message ?? "Unknown error";
          setError(msg);
          toast.error(msg);
          setStreaming(false);
        });
    },
    [streaming, config],
  );

  return { messages, streaming, thinking, hasMore, error, loaded, send, loadMore, reload };
}
