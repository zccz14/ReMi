export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  messages: ChatMessage[];
  temperature?: number;
  responseFormat?: { type: string };
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

export function createChatClient(config: ChatClientConfig): ChatClient {
  async function chat(options: ChatOptions): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: options.messages,
      stream: false,
    };

    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options.responseFormat !== undefined) {
      body.response_format = options.responseFormat;
    }

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
      throw new Error(`Chat API returned no choices: ${detail}`);
    }

    const choice = json.choices[0];
    const msg = choice.message as { content?: string; reasoning_content?: string };
    return {
      content: msg.content || msg.reasoning_content || "",
      finishReason: choice.finish_reason,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        totalTokens: json.usage?.total_tokens ?? 0,
      },
    };
  }

  async function* chatStream(options: ChatOptions): AsyncGenerator<string, void, unknown> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: options.messages,
      stream: true,
    };

    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options.responseFormat !== undefined) {
      body.response_format = options.responseFormat;
    }

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
      throw new Error(`Chat API error ${response.status}: ${text}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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
          if (data === "[DONE]") return;

          const parsed = JSON.parse(data) as {
            choices: { delta: { content?: string; reasoning_content?: string } }[];
          };

          const delta = parsed.choices[0]?.delta;
          const content = delta?.content || delta?.reasoning_content;
          if (content) {
            yield content;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  return { chat, chatStream };
}
