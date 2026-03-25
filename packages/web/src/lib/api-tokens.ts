import type { ApiClient } from "./api-client";

export interface OwnerApiToken {
  id: string;
  tokenPrefix: string;
  note: string;
  createdAt: string;
}

export interface CreatedOwnerApiToken {
  id: string;
  note: string;
  createdAt: string;
}

export function buildApiTokenPrefix(id: string) {
  return `${id.slice(0, 6)}...`;
}

export async function listOwnerApiTokens(apiClient: ApiClient): Promise<OwnerApiToken[]> {
  const response = await apiClient.get<{ items: OwnerApiToken[] }>(
    apiClient.ownerPath("/api-tokens"),
  );
  return response.items ?? [];
}

export async function createOwnerApiToken(
  apiClient: ApiClient,
  input: { note: string },
): Promise<CreatedOwnerApiToken> {
  return apiClient.post<CreatedOwnerApiToken>(apiClient.ownerPath("/api-tokens"), input);
}

export async function deleteOwnerApiToken(apiClient: ApiClient, id: string): Promise<void> {
  await apiClient.del(apiClient.ownerPath(`/api-tokens/${id}`));
}
