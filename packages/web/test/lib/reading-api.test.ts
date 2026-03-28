import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/lib/api-client";
import { createReadingApi } from "../../src/lib/reading-api";

describe("createReadingApi", () => {
  it("uses the signed owner API for first-round generation", async () => {
    const apiClient = {
      ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
      post: vi.fn().mockResolvedValue({
        data: {
          items: [
            {
              id: "item-1",
              question: "question-1",
              answer: "answer-1",
              themeId: "theme-a",
              themeLabel: "价值观判断",
              score: 0.9,
            },
          ],
          candidatePool: [],
        },
      }),
    } as unknown as ApiClient;

    const readingApi = createReadingApi(apiClient);
    const result = await readingApi.generateFirstRound({ text: "x".repeat(800), locale: "zh" });

    expect(apiClient.ownerPath).toHaveBeenCalledWith("/reading/start");
    expect(apiClient.post).toHaveBeenCalledWith("/api/mock-public-key/reading/start", {
      text: "x".repeat(800),
      locale: "zh",
    });
    expect(result.items).toHaveLength(1);
  });
});
