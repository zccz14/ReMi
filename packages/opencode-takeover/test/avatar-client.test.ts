import { describe, expect, it, vi } from "vitest";
import { createAvatarClient } from "../src/avatar-client.ts";

describe("createAvatarClient", () => {
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
