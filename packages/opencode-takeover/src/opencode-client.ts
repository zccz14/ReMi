import type { SessionMessage } from "./types.ts";

interface SessionSummary {
  id: string;
}

export interface OpencodeClient {
  getSession(sessionId: string): Promise<SessionSummary>;
  listMessages(sessionId: string, limit: number): Promise<SessionMessage[]>;
  writePrompt(sessionId: string, text: string): Promise<void>;
}

export function createOpencodeClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): OpencodeClient {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

  return {
    async getSession(sessionId) {
      const response = await fetchImpl(`${normalizedBaseUrl}/session/${sessionId}`);
      if (!response.ok) {
        throw new Error(`Failed to load OpenCode session ${sessionId}: ${response.status}`);
      }
      return (await response.json()) as SessionSummary;
    },

    async listMessages(sessionId, limit) {
      const response = await fetchImpl(
        `${normalizedBaseUrl}/session/${sessionId}/message?limit=${limit}`,
      );
      if (!response.ok) {
        throw new Error(`Failed to load OpenCode messages for ${sessionId}: ${response.status}`);
      }
      return (await response.json()) as SessionMessage[];
    },

    async writePrompt(sessionId, text) {
      const response = await fetchImpl(`${normalizedBaseUrl}/session/${sessionId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text }] }),
      });
      const body = (await response.json()) as { info?: { role?: string } };
      if (response.status !== 200 || body.info?.role !== "assistant") {
        throw new Error(`OpenCode writePrompt failed for ${sessionId}`);
      }
    },
  };
}
