import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { type SSEHandlers } from "../lib/sse-client";
import { getConversationFlowMode } from "../config/feature-flags";

export interface ChatMessage {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: number;
  shared_message_id?: string;
  sender_key?: string;
  sender_kind?: "owner" | "avatar";
  body?: Record<string, unknown> | null;
}

export interface ChatConfig {
  loadMessages: (params: {
    limit?: number;
    before?: number;
  }) => Promise<{ items: ChatMessage[]; hasMore: boolean }>;
  sendMessage: (content: string, handlers: SSEHandlers) => Promise<void>;
}

export type ChatPhase =
  | "idle"
  | "bootstrapping"
  | "extracting"
  | "recalling"
  | "detecting"
  | "generating";

const PHASES: ChatPhase[] = [
  "idle",
  "bootstrapping",
  "extracting",
  "recalling",
  "detecting",
  "generating",
];

function isChatPhase(value: string): value is ChatPhase {
  return PHASES.includes(value as ChatPhase);
}

export function useChat(config: ChatConfig) {
  const mode = getConversationFlowMode();
  const observabilityEnabled = mode !== "off";

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [thinking, setThinking] = useState<string | null>(null);
  const [thinkingItems, setThinkingItems] = useState<string[]>([]);
  const [phase, setPhase] = useState<ChatPhase>("idle");
  const [ttfpMs, setTtfpMs] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const requestSeq = useRef(0);
  const activeRequestId = useRef<number | null>(null);

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
      setThinkingItems([]);
      setPhase("idle");
      setTtfpMs(null);
      setError(null);

      const requestId = requestSeq.current + 1;
      requestSeq.current = requestId;
      activeRequestId.current = requestId;
      const sendStartedAt = Date.now();
      let hasFirstProgress = false;
      let hasTerminalEvent = false;

      const markFirstProgress = () => {
        if (hasFirstProgress) return;
        hasFirstProgress = true;
        setTtfpMs(Date.now() - sendStartedAt);
      };

      let assistantContent = "";
      const assistantId = -(Date.now() + 1);

      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant" as const, content: "", created_at: Date.now() },
      ]);

      config
        .sendMessage(content, {
          onThinking: (narrative) => {
            if (activeRequestId.current !== requestId) return;
            markFirstProgress();
            setThinking(narrative);
            if (observabilityEnabled) {
              setThinkingItems((prev) => [...prev, narrative]);
            }
          },
          onPhase: (data) => {
            if (activeRequestId.current !== requestId) return;
            markFirstProgress();
            if (!observabilityEnabled) return;
            if (isChatPhase(data.phase) && data.phase !== "idle") {
              setPhase(data.phase);
            }
          },
          onToken: (token) => {
            if (activeRequestId.current !== requestId) return;
            markFirstProgress();
            assistantContent += token;
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: assistantContent } : m)),
            );
          },
          onDone: (data) => {
            if (activeRequestId.current !== requestId) return;
            hasTerminalEvent = true;
            activeRequestId.current = null;
            const msgId = (data as { messageId?: number }).messageId;
            if (msgId) {
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, id: msgId } : m)),
              );
            }
            setStreaming(false);
            setThinking(null);
            setPhase("idle");
          },
          onError: (err) => {
            if (activeRequestId.current !== requestId) return;
            hasTerminalEvent = true;
            activeRequestId.current = null;
            setError(err.message);
            toast.error(err.message);
            setStreaming(false);
            setThinking(null);
            setPhase("idle");
          },
        })
        .catch((err: Error) => {
          if (activeRequestId.current !== requestId) return;
          activeRequestId.current = null;
          const msg = err.message ?? "Unknown error";
          setError(msg);
          toast.error(msg);
          setStreaming(false);
          setThinking(null);
          setPhase("idle");
        })
        .finally(() => {
          if (activeRequestId.current !== requestId || hasTerminalEvent) return;
          activeRequestId.current = null;
          setStreaming(false);
          setThinking(null);
          setPhase("idle");
        });
    },
    [streaming, config, observabilityEnabled],
  );

  return {
    messages,
    streaming,
    thinking,
    thinkingItems,
    phase,
    ttfpMs,
    hasMore,
    error,
    loaded,
    send,
    loadMore,
    reload,
  };
}
