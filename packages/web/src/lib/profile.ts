export interface PublicProfile {
  displayName: string;
  bio: string;
  hasAvatar: boolean;
  avatarVersion: number | null;
  updatedAt: number | null;
}

export const emptyPublicProfile: PublicProfile = {
  displayName: "",
  bio: "",
  hasAvatar: false,
  avatarVersion: null,
  updatedAt: null,
};

export function getApiBaseUrl(): string {
  const rawBaseUrl = import.meta.env.VITE_API_BASE ?? window.location.origin;
  return rawBaseUrl.replace(/\/+$/, "");
}

export function buildPublicProfileUrl(pubKey: string): string {
  return `${getApiBaseUrl()}/api/public/${pubKey}/profile`;
}

export function buildAvatarUrl(pubKey: string, version: number | null): string | null {
  return version !== null
    ? `${getApiBaseUrl()}/api/public/${pubKey}/profile/avatar?v=${version}`
    : null;
}

export function getFallbackDisplayName(pubKey: string, displayName: string): string {
  const trimmedDisplayName = displayName.trim();
  return trimmedDisplayName || `${pubKey.slice(0, 6)}...${pubKey.slice(-4)}`;
}
