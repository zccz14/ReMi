import { describe, expect, it, vi } from "vitest";
import { createOpencodeClient } from "../src/opencode-client.ts";

describe("createOpencodeClient", () => {
  it("posts takeover prompts with the fixed request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ info: { role: "assistant" } }),
    });

    const client = createOpencodeClient("http://localhost:4096", fetchMock as typeof fetch);
    await client.writePrompt("ses_demo", "next prompt");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4096/session/ses_demo/message",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );
  });

  it("rejects non-200 write responses even when fetch marks them ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ info: { role: "assistant" } }),
    });

    const client = createOpencodeClient("http://localhost:4096", fetchMock as typeof fetch);

    await expect(client.writePrompt("ses_demo", "next prompt")).rejects.toThrow(
      /writePrompt failed/i,
    );
  });

  it("rejects write responses without an assistant info payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ info: { role: "user" } }),
    });

    const client = createOpencodeClient("http://localhost:4096", fetchMock as typeof fetch);

    await expect(client.writePrompt("ses_demo", "next prompt")).rejects.toThrow(
      /writePrompt failed/i,
    );
  });
});
