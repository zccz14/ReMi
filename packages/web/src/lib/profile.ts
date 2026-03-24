export interface PublicProfile {
  displayName: string;
  bio: string;
  hasAvatar: boolean;
  avatarVersion: number | null;
  updatedAt: number | null;
}

export interface ResolvedProfileSummary {
  pubKey: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
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

export function resolveProfileSummary(
  pubKey: string,
  profile: PublicProfile,
): ResolvedProfileSummary {
  return {
    pubKey,
    displayName: getFallbackDisplayName(pubKey, profile.displayName),
    bio: profile.bio.trim(),
    avatarUrl: profile.hasAvatar ? buildAvatarUrl(pubKey, profile.avatarVersion) : null,
  };
}

const publicProfileCache = new Map<string, Promise<ResolvedProfileSummary>>();

interface ProfileSummaryFetchResult {
  summary: ResolvedProfileSummary;
  cacheable: boolean;
}

export function clearPublicProfileCache(): void {
  publicProfileCache.clear();
}

export function loadPublicProfileSummary(pubKey: string): Promise<ResolvedProfileSummary> {
  if (!publicProfileCache.has(pubKey)) {
    const request = fetchProfileSummary(pubKey).then(({ summary, cacheable }) => {
      if (!cacheable) {
        publicProfileCache.delete(pubKey);
      }

      return summary;
    });

    publicProfileCache.set(pubKey, request);
  }

  return publicProfileCache.get(pubKey)!;
}

function normalizePublicProfile(profile: unknown): PublicProfile {
  if (!profile || typeof profile !== "object") {
    return emptyPublicProfile;
  }

  const candidate = profile as Record<string, unknown>;

  return {
    displayName:
      typeof candidate.displayName === "string"
        ? candidate.displayName
        : emptyPublicProfile.displayName,
    bio: typeof candidate.bio === "string" ? candidate.bio : emptyPublicProfile.bio,
    hasAvatar:
      typeof candidate.hasAvatar === "boolean" ? candidate.hasAvatar : emptyPublicProfile.hasAvatar,
    avatarVersion:
      typeof candidate.avatarVersion === "number"
        ? candidate.avatarVersion
        : emptyPublicProfile.avatarVersion,
    updatedAt:
      typeof candidate.updatedAt === "number" ? candidate.updatedAt : emptyPublicProfile.updatedAt,
  };
}

async function fetchProfileSummary(pubKey: string): Promise<ProfileSummaryFetchResult> {
  try {
    const response = await fetch(buildPublicProfileUrl(pubKey));
    if (!response.ok) {
      return {
        summary: resolveProfileSummary(pubKey, emptyPublicProfile),
        cacheable: false,
      };
    }

    const payload = (await response.json()) as { data?: unknown };
    return {
      summary: resolveProfileSummary(pubKey, normalizePublicProfile(payload.data)),
      cacheable: true,
    };
  } catch {
    return {
      summary: resolveProfileSummary(pubKey, emptyPublicProfile),
      cacheable: false,
    };
  }
}
