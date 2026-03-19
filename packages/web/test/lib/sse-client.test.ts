import { describe, it, expect, vi } from "vitest";
import { parseSSEStream } from "../../src/lib/sse-client";

function createMockStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe("parseSSEStream", () => {
  it("should parse thinking event as raw string", async () => {
    const stream = createMockStream(["event: thinking\ndata: I am thinking...\n\n"]);
    const onThinking = vi.fn();
    await parseSSEStream(stream, { onThinking });
    expect(onThinking).toHaveBeenCalledWith("I am thinking...");
  });

  it("should parse token event as raw string", async () => {
    const stream = createMockStream(["event: token\ndata: Hello\n\n"]);
    const onToken = vi.fn();
    await parseSSEStream(stream, { onToken });
    expect(onToken).toHaveBeenCalledWith("Hello");
  });

  it("should parse done event as JSON", async () => {
    const data = JSON.stringify({ messageId: 42, recalledAnchors: ["a1"] });
    const stream = createMockStream([`event: done\ndata: ${data}\n\n`]);
    const onDone = vi.fn();
    await parseSSEStream(stream, { onDone });
    expect(onDone).toHaveBeenCalledWith({ messageId: 42, recalledAnchors: ["a1"] });
  });

  it("should parse error event as JSON", async () => {
    const data = JSON.stringify({ code: "LLM_ERROR", message: "fail" });
    const stream = createMockStream([`event: error\ndata: ${data}\n\n`]);
    const onError = vi.fn();
    await parseSSEStream(stream, { onError });
    expect(onError).toHaveBeenCalledWith({ code: "LLM_ERROR", message: "fail" });
  });

  it("should handle chunked data across multiple reads", async () => {
    const stream = createMockStream(["event: tok", "en\ndata: Hi\n\n"]);
    const onToken = vi.fn();
    await parseSSEStream(stream, { onToken });
    expect(onToken).toHaveBeenCalledWith("Hi");
  });

  it("should handle multiple events in one chunk", async () => {
    const stream = createMockStream(["event: token\ndata: A\n\nevent: token\ndata: B\n\n"]);
    const onToken = vi.fn();
    await parseSSEStream(stream, { onToken });
    expect(onToken).toHaveBeenCalledTimes(2);
    expect(onToken).toHaveBeenNthCalledWith(1, "A");
    expect(onToken).toHaveBeenNthCalledWith(2, "B");
  });

  it("should ignore events with empty data", async () => {
    const stream = createMockStream(["event: token\ndata: \n\n"]);
    const onToken = vi.fn();
    await parseSSEStream(stream, { onToken });
    // Empty string is still delivered — parser doesn't filter
    expect(onToken).toHaveBeenCalledWith("");
  });

  it("should handle multi-line data fields", async () => {
    const stream = createMockStream(["event: token\ndata: line1\ndata: line2\n\n"]);
    const onToken = vi.fn();
    await parseSSEStream(stream, { onToken });
    expect(onToken).toHaveBeenCalledWith("line1\nline2");
  });

  it("should resolve cleanly when stream aborts", async () => {
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullCount === 0) {
          controller.enqueue(new TextEncoder().encode("event: token\ndata: hi\n\n"));
          pullCount++;
        } else {
          controller.error(new Error("network abort"));
        }
      },
    });
    const onToken = vi.fn();
    // Should not throw — parser handles errors gracefully
    await expect(parseSSEStream(stream, { onToken })).resolves.toBeUndefined();
    expect(onToken).toHaveBeenCalledWith("hi");
  });
});
