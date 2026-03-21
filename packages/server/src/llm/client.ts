import { logger } from "../logger.js";

const log = logger.child({ module: "llm" });

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  messages: ChatMessage[];
  temperature?: number;
}

export interface ChatResponse {
  content: string;
  finishReason: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ChatClientConfig {
  apiBase: string;
  apiKey: string;
  model: string;
}

export interface ChatClient {
  chat(options: ChatOptions): Promise<ChatResponse>;
  chatStream(options: ChatOptions): AsyncGenerator<string, void, unknown>;
}

function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  const systemContents = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content.trim())
    .filter(Boolean);
  const nonSystem = messages.filter((m) => m.role !== "system");

  if (systemContents.length === 0) {
    return messages;
  }

  const systemPrompt = systemContents.join("\n\n");

  if (nonSystem.length === 0) {
    return [{ role: "user", content: systemPrompt }];
  }

  if (nonSystem[0].role === "user") {
    return [
      {
        role: "user",
        content: `${systemPrompt}\n\n${nonSystem[0].content}`,
      },
      ...nonSystem.slice(1),
    ];
  }

  return [{ role: "user", content: systemPrompt }, ...nonSystem];
}

export function createChatClient(config: ChatClientConfig): ChatClient {
  async function chat(options: ChatOptions): Promise<ChatResponse> {
    const start = Date.now();
    const messages = normalizeMessages(options.messages);
    const msgCount = messages.length;

    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      stream: false,
    };

    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    log.debug({ model: config.model, msgCount }, "LLM chat request");

    const response = await fetch(`${config.apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      const ms = Date.now() - start;
      log.error({ model: config.model, status: response.status, ms }, "LLM chat API error");
      throw new Error(`Chat API error ${response.status}: ${text}`);
    }

    const json = (await response.json()) as {
      choices?: {
        message: { role: string; content: string };
        finish_reason: string;
      }[];
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
      error?: { message: string; type: string; code: string };
    };

    if (!json.choices || json.choices.length === 0) {
      const detail = json.error
        ? `${json.error.type}: ${json.error.message}`
        : JSON.stringify(json);
      const ms = Date.now() - start;
      log.error({ model: config.model, ms, detail }, "LLM chat returned no choices");
      throw new Error(`Chat API returned no choices: ${detail}`);
    }

    const choice = json.choices[0];
    const msg = choice.message as { content?: string };
    const result: ChatResponse = {
      content: msg.content || "",
      finishReason: choice.finish_reason,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        totalTokens: json.usage?.total_tokens ?? 0,
      },
    };

    const ms = Date.now() - start;
    log.info(
      {
        model: config.model,
        ms,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
        finishReason: result.finishReason,
      },
      "LLM chat completed",
    );

    return result;
  }

  async function* chatStream(options: ChatOptions): AsyncGenerator<string, void, unknown> {
    const start = Date.now();
    const messages = normalizeMessages(options.messages);
    const msgCount = messages.length;

    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      stream: true,
    };

    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    log.debug({ model: config.model, msgCount }, "LLM stream request");

    const response = await fetch(`${config.apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      const ms = Date.now() - start;
      log.error({ model: config.model, status: response.status, ms }, "LLM stream API error");
      throw new Error(`Chat API error ${response.status}: ${text}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let tokenCount = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        // Keep the last (possibly incomplete) line in the buffer
        buffer = lines.pop()!;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            const ms = Date.now() - start;
            log.info({ model: config.model, ms, streamTokens: tokenCount }, "LLM stream completed");
            return;
          }

          const parsed = JSON.parse(data) as {
            choices: { delta: { content?: string; reasoning_content?: string } }[];
          };

          const delta = parsed.choices[0]?.delta;
          const content = delta?.content;
          if (content) {
            tokenCount++;
            yield content;
          }
        }
      }

      const ms = Date.now() - start;
      log.info({ model: config.model, ms, streamTokens: tokenCount }, "LLM stream completed");
    } finally {
      reader.releaseLock();
    }
  }

  return { chat, chatStream };
}
