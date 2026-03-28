import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/lib/api-client";
import { createReadingApi, persistReadingApprovedAnchors } from "../../src/lib/reading-api";

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

  it("persists approved reading anchors through approval candidate ingestion", async () => {
    const apiClient = {
      ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
      post: vi.fn().mockResolvedValue({ data: {} }),
    } as unknown as ApiClient;

    await persistReadingApprovedAnchors(apiClient, [
      {
        id: "approved-1",
        question: "What matters most?",
        answer: "Trust",
        themeId: "value-judgments",
        themeLabel: "价值观判断",
      },
    ]);

    expect(apiClient.ownerPath).toHaveBeenCalledWith("/approval/candidates");
    expect(apiClient.post).toHaveBeenCalledWith("/api/mock-public-key/approval/candidates", {
      question: "What matters most?",
      answer: "Trust",
      source: "reading",
      sourceRef: "reading:approved-1",
      sourceSnapshot: {
        approvedAnchorId: "approved-1",
        themeId: "value-judgments",
        themeLabel: "价值观判断",
      },
    });
  });
});
