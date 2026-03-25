import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/lib/api-client";
import {
  buildApiTokenPrefix,
  createOwnerApiToken,
  deleteOwnerApiToken,
  listOwnerApiTokens,
} from "../../src/lib/api-tokens";

function createApiClientMock() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    del: vi.fn(),
    ownerPath: vi.fn((path: string) => `/api/mock-public-key${path}`),
  } as unknown as ApiClient;
}

describe("api token helpers", () => {
  let apiClient: ApiClient;

  beforeEach(() => {
    apiClient = createApiClientMock();
  });

  it("lists owner api tokens from the owner route", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      items: [
        { id: "sk-secret", tokenPrefix: "sk-sec...", note: "Cursor", createdAt: "2026-03-25" },
      ],
    });

    await expect(listOwnerApiTokens(apiClient)).resolves.toEqual([
      { id: "sk-secret", tokenPrefix: "sk-sec...", note: "Cursor", createdAt: "2026-03-25" },
    ]);
    expect(apiClient.ownerPath).toHaveBeenCalledWith("/api-tokens");
    expect(apiClient.get).toHaveBeenCalledWith("/api/mock-public-key/api-tokens");
  });

  it("creates an owner api token through the owner route", async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      id: "sk-secret",
      note: "CLI",
      createdAt: "2026-03-25",
    });

    await expect(createOwnerApiToken(apiClient, { note: "CLI" })).resolves.toEqual({
      id: "sk-secret",
      note: "CLI",
      createdAt: "2026-03-25",
    });
    expect(apiClient.ownerPath).toHaveBeenCalledWith("/api-tokens");
    expect(apiClient.post).toHaveBeenCalledWith("/api/mock-public-key/api-tokens", {
      note: "CLI",
    });
  });

  it("deletes an owner api token through the owner route", async () => {
    vi.mocked(apiClient.del).mockResolvedValue(undefined);

    await expect(deleteOwnerApiToken(apiClient, "sk-secret")).resolves.toBeUndefined();
    expect(apiClient.ownerPath).toHaveBeenCalledWith("/api-tokens/sk-secret");
    expect(apiClient.del).toHaveBeenCalledWith("/api/mock-public-key/api-tokens/sk-secret");
  });

  it("builds the masked api token prefix", () => {
    expect(buildApiTokenPrefix("sk-1234567890")).toBe("sk-123...");
  });
});
