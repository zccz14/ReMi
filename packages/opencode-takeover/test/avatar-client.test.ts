import { describe, expect, it, vi } from "vitest";
import { createAvatarClient } from "../src/avatar-client.ts";
import { AVATAR_SYSTEM_PROMPT } from "../src/avatar-system-prompt.ts";

describe("createAvatarClient", () => {
  it("defines a non-empty manager prompt owned by the takeover module", () => {
    expect(typeof AVATAR_SYSTEM_PROMPT).toBe("string");
    expect(AVATAR_SYSTEM_PROMPT.trim().length).toBeGreaterThan(0);
    expect(AVATAR_SYSTEM_PROMPT).toContain("OpenCode");
    expect(AVATAR_SYSTEM_PROMPT).toContain("Reply with the single next user message");
  });

  it("prepends the fixed system prompt and preserves mirrored history", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "next user prompt" } }] }),
    });
    const mirroredHistory = [
      { role: "user" as const, content: "done" },
      { role: "assistant" as const, content: "Need anything else?" },
      { role: "user" as const, content: "Summarize status for me" },
    ];

    const client = createAvatarClient({
      baseUrl: "http://localhost:3001",
      model: "ReMi-demo",
      fetchImpl: fetchMock as typeof fetch,
    });

    await client.nextPrompt(mirroredHistory);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      model: string;
      stream: boolean;
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    };

    expect(requestBody.model).toBe("ReMi-demo");
    expect(requestBody.stream).toBe(false);
    expect(requestBody.messages[0]).toEqual({
      role: "system",
      content: AVATAR_SYSTEM_PROMPT,
    });
    expect(requestBody.messages.slice(1)).toEqual(mirroredHistory);
  });

  it("rejects when the avatar API responds with a non-OK status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    });

    const client = createAvatarClient({
      baseUrl: "http://localhost:3001",
      model: "ReMi-demo",
      fetchImpl: fetchMock as typeof fetch,
    });

    await expect(client.nextPrompt([{ role: "user", content: "done" }])).rejects.toThrow(
      "Avatar API request failed: 503",
    );
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

  it("returns an empty string when the avatar response content is missing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: {} }] }),
    });

    const client = createAvatarClient({
      baseUrl: "http://localhost:3001",
      model: "ReMi-demo",
      fetchImpl: fetchMock as typeof fetch,
    });

    await expect(client.nextPrompt([{ role: "user", content: "done" }])).resolves.toBe("");
  });

  it("rejects when the avatar response content has an unsupported non-string shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: [{ type: "text", text: "nope" }] } }] }),
    });

    const client = createAvatarClient({
      baseUrl: "http://localhost:3001",
      model: "ReMi-demo",
      fetchImpl: fetchMock as typeof fetch,
    });

    await expect(client.nextPrompt([{ role: "user", content: "done" }])).rejects.toThrow(
      /unsupported.*message\.content/i,
    );
  });

  it("returns an empty string when the avatar response content is whitespace only", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "   \n\t  " } }] }),
    });

    const client = createAvatarClient({
      baseUrl: "http://localhost:3001",
      model: "ReMi-demo",
      fetchImpl: fetchMock as typeof fetch,
    });

    await expect(client.nextPrompt([{ role: "user", content: "done" }])).resolves.toBe("");
  });

  it("preserves non-empty avatar response content including surrounding whitespace", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "  next user prompt  " } }] }),
    });

    const client = createAvatarClient({
      baseUrl: "http://localhost:3001",
      model: "ReMi-demo",
      fetchImpl: fetchMock as typeof fetch,
    });

    await expect(client.nextPrompt([{ role: "user", content: "done" }])).resolves.toBe(
      "  next user prompt  ",
    );
  });
});
