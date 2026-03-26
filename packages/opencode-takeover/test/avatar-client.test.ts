import { describe, expect, it, vi } from "vitest";
import { createAvatarClient } from "../src/avatar-client.ts";
import { AVATAR_SYSTEM_PROMPT } from "../src/avatar-system-prompt.ts";

describe("createAvatarClient", () => {
  it("prepends the fixed system prompt to avatar API requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "next user prompt" } }] }),
    });

    const client = createAvatarClient({
      baseUrl: "http://localhost:3001",
      model: "ReMi-demo",
      fetchImpl: fetchMock as typeof fetch,
    });

    await client.nextPrompt([{ role: "user", content: "done" }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "ReMi-demo",
      stream: false,
      messages: [
        {
          role: "system",
          content: AVATAR_SYSTEM_PROMPT,
        },
        { role: "user", content: "done" },
      ],
    });
  });

  it("returns the full assistant text from the avatar API", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "next user prompt" } }] }),
    });

    const client = createAvatarClient({
      baseUrl: "http://localhost:3001",
      model: "ReMi-demo",
      fetchImpl: fetchMock as typeof fetch,
    });

    const reply = await client.nextPrompt([{ role: "user", content: "done" }]);
    expect(reply).toBe("next user prompt");
  });
});
