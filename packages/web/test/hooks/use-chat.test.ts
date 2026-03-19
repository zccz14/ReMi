// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChat, type ChatConfig } from "../../src/hooks/use-chat";

function createMockConfig(): ChatConfig {
  return {
    loadMessages: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe("useChat", () => {
  it("should load messages on init", async () => {
    const config = createMockConfig();
    (config.loadMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [{ id: 1, role: "user", content: "hello", created_at: 1000 }],
      hasMore: false,
    });
    const { result } = renderHook(() => useChat(config));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(config.loadMessages).toHaveBeenCalled();
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].content).toBe("hello");
  });

  it("should add user message optimistically on send", async () => {
    const config = createMockConfig();
    const { result } = renderHook(() => useChat(config));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

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
});
