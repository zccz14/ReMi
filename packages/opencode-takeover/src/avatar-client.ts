import { AVATAR_SYSTEM_PROMPT } from "./avatar-system-prompt.ts";
import type { AvatarRequestMessage, MirroredMessage } from "./types.ts";

export interface AvatarClient {
  nextPrompt(messages: MirroredMessage[]): Promise<string>;
}

export function createAvatarClient(options: {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): AvatarClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl.replace(/\/$/, "")}/chat/completions`;

  return {
    async nextPrompt(messages) {
      const requestMessages: AvatarRequestMessage[] = [
        { role: "system", content: AVATAR_SYSTEM_PROMPT },
        ...messages,
      ];

      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: options.model, messages: requestMessages, stream: false }),
      });
      if (!response.ok) {
        throw new Error(`Avatar API request failed: ${response.status}`);
      }
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (content == null) {
        return "";
      }

      if (typeof content !== "string") {
        throw new Error("Avatar API returned unsupported message.content shape");
      }

      return content.trim() === "" ? "" : content;
    },
  };
}
