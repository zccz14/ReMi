import { describe, it, expect, vi, beforeEach } from "vitest";
import { createChatClient } from "../../src/llm/client.js";

// Mock fetch for testing without real API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("ChatClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("chat (non-streaming)", () => {
    it("should send correct request and parse response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: { role: "assistant", content: "Hello! How can I help?" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
        }),
      });

      const client = createChatClient({
        apiBase: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "gpt-4",
      });

      const result = await client.chat({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.content).toBe("Hello! How can I help?");
      expect(result.finishReason).toBe("stop");
      expect(result.usage).toEqual({
        promptTokens: 10,
        completionTokens: 8,
        totalTokens: 18,
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.example.com/v1/chat/completions");
      expect(options.method).toBe("POST");
      expect(options.headers["Content-Type"]).toBe("application/json");
      expect(options.headers["Authorization"]).toBe("Bearer test-key");

      const body = JSON.parse(options.body);
      expect(body.model).toBe("gpt-4");
      expect(body.messages).toEqual([{ role: "user", content: "Hi" }]);
      expect(body.stream).toBe(false);
    });

    it("should throw on API error with status code", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "Rate limit exceeded",
      });

      const client = createChatClient({
        apiBase: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "gpt-4",
      });

      await expect(client.chat({ messages: [{ role: "user", content: "Hi" }] })).rejects.toThrow(
        "Chat API error 429: Rate limit exceeded",
      );
    });

    it("should pass optional temperature parameter", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: { role: "assistant", content: '{"answer":42}' },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
      });

      const client = createChatClient({
        apiBase: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "gpt-4",
      });

      await client.chat({
        messages: [{ role: "user", content: "What is the answer?" }],
        temperature: 0,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.temperature).toBe(0);
      expect(body.response_format).toBeUndefined();
    });

    it("should not use reasoning_content as final chat content", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                reasoning_content: "internal reasoning",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      });

      const client = createChatClient({
        apiBase: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "gpt-4",
      });

      const result = await client.chat({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.content).toBe("");
    });

    it("should preserve ordered system messages before sending chat request", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      });

      const client = createChatClient({
        apiBase: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "gpt-4",
      });

      await client.chat({
        messages: [
          { role: "system", content: "you are helpful" },
          { role: "user", content: "hello" },
        ],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.messages).toEqual([
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hello" },
      ]);
    });
  });

  describe("chatStream", () => {
    it("should parse SSE stream and yield tokens", async () => {
      const sseData = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join("");

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseData));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: stream,
      });

      const client = createChatClient({
        apiBase: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "gpt-4",
      });

      const tokens: string[] = [];
      for await (const token of client.chatStream({
        messages: [{ role: "user", content: "Hi" }],
      })) {
        tokens.push(token);
      }

      expect(tokens).toEqual(["Hello", " world"]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.stream).toBe(true);
    });

    it("should throw on API error during streaming", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal server error",
      });

      const client = createChatClient({
        apiBase: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "gpt-4",
      });

      const generator = client.chatStream({
        messages: [{ role: "user", content: "Hi" }],
      });

      await expect(generator.next()).rejects.toThrow("Chat API error 500: Internal server error");
    });

    it("should handle chunked SSE data across multiple reads", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          // Simulate chunked delivery: split mid-line
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"con'));
          controller.enqueue(encoder.encode('tent":"chunk"}}]}\n\ndata: [DONE]\n\n'));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: stream,
      });

      const client = createChatClient({
        apiBase: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "gpt-4",
      });

      const tokens: string[] = [];
      for await (const token of client.chatStream({
        messages: [{ role: "user", content: "Hi" }],
      })) {
        tokens.push(token);
      }

      expect(tokens).toEqual(["chunk"]);
    });

    it("should ignore reasoning_content chunks in streaming output", async () => {
      const sseData = [
        'data: {"choices":[{"delta":{"reasoning_content":"think 1"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"final answer"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join("");

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseData));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: stream,
      });

      const client = createChatClient({
        apiBase: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "gpt-4",
      });

      const tokens: string[] = [];
      for await (const token of client.chatStream({
        messages: [{ role: "user", content: "Hi" }],
      })) {
        tokens.push(token);
      }

      expect(tokens).toEqual(["final answer"]);
    });

    it("should preserve ordered system messages before sending stream request", async () => {
      const sseData = [
        'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join("");

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseData));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: stream,
      });

      const client = createChatClient({
        apiBase: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "gpt-4",
      });

      const tokens: string[] = [];
      for await (const token of client.chatStream({
        messages: [
          { role: "system", content: "system prompt" },
          { role: "assistant", content: "history" },
          { role: "user", content: "question" },
        ],
      })) {
        tokens.push(token);
      }

      expect(tokens).toEqual(["done"]);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.messages).toEqual([
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "history" },
        { role: "user", content: "question" },
      ]);
    });
  });
});
