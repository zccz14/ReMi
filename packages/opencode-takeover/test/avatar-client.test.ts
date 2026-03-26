import { describe, expect, it, vi } from "vitest";
import { createAvatarClient } from "../src/avatar-client.ts";
import { AVATAR_SYSTEM_PROMPT } from "../src/avatar-system-prompt.ts";

describe("createAvatarClient", () => {
  it("defines a manager prompt with executor boundaries and delegation flow", () => {
    expect(AVATAR_SYSTEM_PROMPT).toContain("manager");
    expect(AVATAR_SYSTEM_PROMPT).toContain("decision-maker");
    expect(AVATAR_SYSTEM_PROMPT).toContain("OpenCode");
    expect(AVATAR_SYSTEM_PROMPT).toContain("executor");
    expect(AVATAR_SYSTEM_PROMPT).toContain("Do not");
    expect(AVATAR_SYSTEM_PROMPT).toContain("file");
    expect(AVATAR_SYSTEM_PROMPT).toContain("code");
    expect(AVATAR_SYSTEM_PROMPT).toContain("command");
    expect(AVATAR_SYSTEM_PROMPT).toContain("search");
    expect(AVATAR_SYSTEM_PROMPT).toContain("fact-finding");
    expect(AVATAR_SYSTEM_PROMPT).toContain("restate the goal");
    expect(AVATAR_SYSTEM_PROMPT).toContain("delegate");
    expect(AVATAR_SYSTEM_PROMPT).toContain("acceptance");
    expect(AVATAR_SYSTEM_PROMPT).toContain("report back");
    expect(AVATAR_SYSTEM_PROMPT).toContain("If asked to do executor work");
    expect(AVATAR_SYSTEM_PROMPT).toContain("re-delegate");
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
});
