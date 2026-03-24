// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChat, type ChatConfig } from "../../src/hooks/use-chat";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

const mockGetConversationFlowMode = vi.fn<() => "off" | "full" | "observability-only">(
  () => "observability-only",
);

vi.mock("../../src/config/feature-flags", () => ({
  getConversationFlowMode: () => mockGetConversationFlowMode(),
}));

function createMockConfig(): ChatConfig {
  return {
    loadMessages: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

async function waitForLoad(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("useChat", () => {
  beforeEach(() => {
    mockGetConversationFlowMode.mockReturnValue("observability-only");
  });

  it("should load messages on init", async () => {
    const config = createMockConfig();
    (config.loadMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        {
          id: 1,
          role: "user",
          content: "hello",
          created_at: 1000,
          shared_message_id: "shared-1",
          sender_key: "sender-1",
          sender_kind: "owner",
          body: { type: "text", version: 1, text: "hello" },
        },
      ],
      hasMore: false,
    });
    const { result } = renderHook(() => useChat(config));

    await waitForLoad();

    expect(config.loadMessages).toHaveBeenCalled();
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].content).toBe("hello");
    expect(result.current.messages[0].shared_message_id).toBe("shared-1");
  });

  it("should add user message optimistically on send", async () => {
    const config = createMockConfig();
    const { result } = renderHook(() => useChat(config));

    await waitForLoad();

    act(() => {
      result.current.send("hi");
    });

    // After send: user msg + assistant placeholder
    expect(result.current.messages.length).toBeGreaterThanOrEqual(1);
    const userMsg = result.current.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe("hi");
    expect(result.current.streaming).toBe(true);
  });

  it("should expose streaming and thinking state", () => {
    const config = createMockConfig();
    const { result } = renderHook(() => useChat(config));
    expect(result.current.streaming).toBe(false);
    expect(result.current.thinking).toBeNull();
  });

  it("tracks phase lifecycle and resets phase to idle on done", async () => {
    let handlers: Parameters<ChatConfig["sendMessage"]>[1] | null = null;
    const config = createMockConfig();
    (config.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async (_content, h) => {
      handlers = h;
    });

    const { result } = renderHook(() => useChat(config));
    await waitForLoad();

    act(() => {
      result.current.send("hello");
    });

    act(() => {
      handlers?.onPhase?.({ phase: "bootstrapping" });
    });
    expect(result.current.phase).toBe("bootstrapping");

    act(() => {
      handlers?.onPhase?.({ phase: "generating" });
    });
    expect(result.current.phase).toBe("generating");

    act(() => {
      handlers?.onDone?.({ messageId: 101 });
    });
    expect(result.current.phase).toBe("idle");
    expect(result.current.streaming).toBe(false);
  });

  it("appends thinkingItems timeline in observability mode", async () => {
    let handlers: Parameters<ChatConfig["sendMessage"]>[1] | null = null;
    const config = createMockConfig();
    (config.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async (_content, h) => {
      handlers = h;
    });

    const { result } = renderHook(() => useChat(config));
    await waitForLoad();

    act(() => {
      result.current.send("hello");
      handlers?.onThinking?.("step 1");
      handlers?.onThinking?.("step 2");
    });

    expect(result.current.thinking).toBe("step 2");
    expect(result.current.thinkingItems).toEqual(["step 1", "step 2"]);
  });

  it("keeps thinking timeline disabled in off mode", async () => {
    mockGetConversationFlowMode.mockReturnValue("off");

    let handlers: Parameters<ChatConfig["sendMessage"]>[1] | null = null;
    const config = createMockConfig();
    (config.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async (_content, h) => {
      handlers = h;
    });

    const { result } = renderHook(() => useChat(config));
    await waitForLoad();

    act(() => {
      result.current.send("hello");
      handlers?.onPhase?.({ phase: "extracting" });
      handlers?.onThinking?.("hidden step");
    });

    expect(result.current.phase).toBe("idle");
    expect(result.current.thinkingItems).toEqual([]);
    // Keep legacy single-thinking behavior
    expect(result.current.thinking).toBe("hidden step");
  });

  it("ignores stale callbacks from older requests", async () => {
    const queuedHandlers: Parameters<ChatConfig["sendMessage"]>[1][] = [];
    const config = createMockConfig();
    (config.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async (_content, h) => {
      queuedHandlers.push(h);
    });

    const { result } = renderHook(() => useChat(config));
    await waitForLoad();

    act(() => {
      result.current.send("first");
    });
    const first = queuedHandlers[0];

    act(() => {
      first.onDone?.({ messageId: 1 });
    });

    act(() => {
      result.current.send("second");
    });
    const second = queuedHandlers[1];

    act(() => {
      first.onToken?.("STALE");
      second.onToken?.("fresh");
    });

    expect(result.current.messages.find((m) => m.content.includes("STALE"))).toBeUndefined();
    expect(
      result.current.messages.find((m) => m.role === "assistant" && m.content === "fresh"),
    ).toBeDefined();
  });

  it("resets phase to idle on error", async () => {
    let handlers: Parameters<ChatConfig["sendMessage"]>[1] | null = null;
    const config = createMockConfig();
    (config.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async (_content, h) => {
      handlers = h;
    });

    const { result } = renderHook(() => useChat(config));
    await waitForLoad();

    act(() => {
      result.current.send("hello");
      handlers?.onPhase?.({ phase: "detecting" });
      handlers?.onError?.({ code: "LLM_ERROR", message: "boom" });
    });

    expect(result.current.phase).toBe("idle");
    expect(result.current.streaming).toBe(false);
    expect(result.current.error).toBe("boom");
  });

  it("records ttfpMs once from first progress event", async () => {
    let handlers: Parameters<ChatConfig["sendMessage"]>[1] | null = null;
    const config = createMockConfig();
    (config.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async (_content, h) => {
      handlers = h;
    });

    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    const { result } = renderHook(() => useChat(config));
    await waitForLoad();

    act(() => {
      result.current.send("hello");
    });

    now = 1_030;
    act(() => {
      handlers?.onPhase?.({ phase: "bootstrapping" });
    });

    now = 1_090;
    act(() => {
      handlers?.onToken?.("a");
      handlers?.onThinking?.("extra");
    });

    expect(result.current.ttfpMs).toBe(30);
    nowSpy.mockRestore();
  });

  it("recovers streaming state when stream ends without done/error", async () => {
    const config = createMockConfig();
    (config.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const { result } = renderHook(() => useChat(config));
    await waitForLoad();

    act(() => {
      result.current.send("hello");
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.streaming).toBe(false);
    expect(result.current.phase).toBe("idle");
  });
});
