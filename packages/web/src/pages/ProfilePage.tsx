import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MessageSquare } from "lucide-react";
import { FullScreenLayout } from "../components/layout/FullScreenLayout";
import { ChatAvatar } from "../components/chat/ChatAvatar";
import {
  emptyPublicProfile,
  buildAvatarUrl,
  buildPublicProfileUrl,
  getFallbackDisplayName,
  type PublicProfile,
} from "../lib/profile";
import { Button } from "@/components/ui/button";

function truncatePubKey(pubKey: string): string {
  if (pubKey.length <= 13) return pubKey;
  return `${pubKey.slice(0, 6)}...${pubKey.slice(-4)}`;
}

interface PublicProfileResponse {
  data: PublicProfile;
}

type ProfileStatus = "loading" | "ready" | "not-found" | "invalid-link" | "error";

export function ProfilePage() {
  const { t } = useTranslation();
  const { pubKey } = useParams<{ pubKey: string }>();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<PublicProfile>(emptyPublicProfile);
  const [status, setStatus] = useState<ProfileStatus>("loading");
  const [avatarLoadFailed, setAvatarLoadFailed] = useState(false);

  if (!pubKey) return null;

  useEffect(() => {
    let isActive = true;

    setProfile(emptyPublicProfile);
    setStatus("loading");
    setAvatarLoadFailed(false);

    const loadProfile = async () => {
      try {
        const response = await fetch(buildPublicProfileUrl(pubKey));
        if (!response.ok) {
          if (!isActive) return;
          if (response.status === 404) {
            setStatus("not-found");
          } else if (response.status === 422) {
            setStatus("invalid-link");
          } else {
            setStatus("error");
          }
          return;
        }

        const payload = (await response.json()) as PublicProfileResponse;
        if (isActive) {
          setProfile(payload.data ?? emptyPublicProfile);
          setStatus("ready");
        }
      } catch {
        if (isActive) {
          setProfile(emptyPublicProfile);
          setStatus("error");
        }
      }
    };

    void loadProfile();

    return () => {
      isActive = false;
    };
  }, [pubKey]);

  useEffect(() => {
    setAvatarLoadFailed(false);
  }, [pubKey, profile.avatarVersion]);

  const avatarUrl = profile.hasAvatar ? buildAvatarUrl(pubKey, profile.avatarVersion) : null;
  const truncatedPubKey = truncatePubKey(pubKey);
  const displayName = useMemo(
    () => getFallbackDisplayName(pubKey, profile.displayName),
    [profile.displayName, pubKey],
  );
  const bio = profile.bio.trim();

  if (status !== "ready") {
    const message =
      status === "loading"
        ? t("profile.loading")
        : status === "not-found"
          ? t("profile.notFound")
          : status === "invalid-link"
            ? t("profile.invalidLink")
            : t("profile.error");

    return (
      <FullScreenLayout title={t("profile.title")}>
        <div className="flex flex-col items-center justify-center gap-4 p-8 h-full text-center">
          <div className="text-lg font-semibold">{truncatePubKey(pubKey)}</div>
          <div className="text-sm text-muted-foreground">{message}</div>
        </div>
      </FullScreenLayout>
    );
  }

  return (
    <FullScreenLayout title={t("profile.title")}>
      <div className="flex flex-col items-center justify-center gap-6 p-8 h-full">
        {avatarUrl && !avatarLoadFailed ? (
          <img
            src={avatarUrl}
            alt={displayName}
            className="h-[72px] w-[72px] rounded-[14px] object-cover"
            onError={() => setAvatarLoadFailed(true)}
          />
        ) : (
          <ChatAvatar pubKey={pubKey} name={displayName} size="lg" />
        )}
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="text-xl font-semibold break-all">{displayName}</div>
          <div className="text-sm font-mono text-muted-foreground break-all max-w-[300px]">
            {truncatedPubKey}
          </div>
          {bio ? (
            <div className="text-sm text-muted-foreground max-w-[320px] whitespace-pre-wrap">
              {bio}
            </div>
          ) : null}
        </div>
        <Button onClick={() => navigate(`/chat/${pubKey}`)}>
          <MessageSquare className="h-4 w-4 mr-2" />
          {t("profile.sendMessage")}
        </Button>
      </div>
    </FullScreenLayout>
  );
}
