import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { useAuth } from "../hooks/use-auth";
import { ChatAvatar } from "../components/chat/ChatAvatar";
import { FullScreenLayout } from "../components/layout/FullScreenLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  buildAvatarUrl,
  emptyPublicProfile,
  getFallbackDisplayName,
  type PublicProfile,
} from "@/lib/profile";

type BootstrapStatus = "loading" | "ready" | "error";

interface SharePageProps {
  forceQrImageFallback?: "auto" | "logo" | "none";
}

export function SharePage({ forceQrImageFallback = "auto" }: SharePageProps) {
  const { t } = useTranslation();
  const { publicKey, apiClient } = useAuth();
  const [bootstrapStatus, setBootstrapStatus] = useState<BootstrapStatus>("loading");
  const [profile, setProfile] = useState<PublicProfile>(emptyPublicProfile);
  const [cardAvatarFailed, setCardAvatarFailed] = useState(false);
  const [qrAvatarFailed, setQrAvatarFailed] = useState(false);
  const [qrLogoFailed, setQrLogoFailed] = useState(false);
  const qrAvatarFailureLockedRef = useRef(false);
  const qrLogoFailureLockedRef = useRef(false);

  useEffect(() => {
    let active = true;

    if (!publicKey?.trim()) {
      setProfile(emptyPublicProfile);
      setCardAvatarFailed(false);
      setQrAvatarFailed(false);
      setQrLogoFailed(false);
      setBootstrapStatus("error");
      return () => {
        active = false;
      };
    }

    setBootstrapStatus("loading");
    setProfile(emptyPublicProfile);
    setCardAvatarFailed(false);
    setQrAvatarFailed(false);
    setQrLogoFailed(false);

    void Promise.resolve(apiClient.get<{ data: PublicProfile }>(apiClient.ownerPath("/profile")))
      .then((response) => {
        if (!active) {
          return;
        }

        setProfile(response.data ?? emptyPublicProfile);
        setBootstrapStatus("ready");
      })
      .catch(() => {
        if (!active) {
          return;
        }

        setProfile(emptyPublicProfile);
        setBootstrapStatus("error");
      });

    return () => {
      active = false;
    };
  }, [apiClient, publicKey]);

  const resolvedDisplayName = publicKey?.trim()
    ? getFallbackDisplayName(publicKey, profile.displayName)
    : t("share.title");
  const bio = profile.bio.trim();
  const avatarUrl =
    publicKey?.trim() && profile.hasAvatar
      ? buildAvatarUrl(publicKey, profile.avatarVersion)
      : null;
  const cardAvatarSrc = avatarUrl && !cardAvatarFailed ? avatarUrl : null;
  const shareUrl = publicKey?.trim() ? `${window.location.origin}/profile/${publicKey}` : "";

  useEffect(() => {
    setCardAvatarFailed(false);
    setQrAvatarFailed(false);
    setQrLogoFailed(false);
    qrAvatarFailureLockedRef.current = false;
    qrLogoFailureLockedRef.current = false;
  }, [avatarUrl]);

  useEffect(() => {
    if (bootstrapStatus !== "ready" || !avatarUrl || forceQrImageFallback !== "auto") {
      return;
    }

    let active = true;
    const probe = new Image();
    probe.onload = () => {
      if (active && !qrAvatarFailureLockedRef.current) {
        setQrAvatarFailed(false);
      }
    };
    probe.onerror = () => {
      if (active) {
        qrAvatarFailureLockedRef.current = true;
        setQrAvatarFailed(true);
      }
    };
    probe.src = avatarUrl;

    return () => {
      active = false;
      probe.onload = null;
      probe.onerror = null;
    };
  }, [avatarUrl, bootstrapStatus, forceQrImageFallback]);

  useEffect(() => {
    if (bootstrapStatus !== "ready" || forceQrImageFallback !== "auto") {
      return;
    }

    if (avatarUrl && !qrAvatarFailed) {
      return;
    }

    let active = true;
    const probe = new Image();
    probe.onload = () => {
      if (active && !qrLogoFailureLockedRef.current) {
        setQrLogoFailed(false);
      }
    };
    probe.onerror = () => {
      if (active) {
        qrLogoFailureLockedRef.current = true;
        setQrLogoFailed(true);
      }
    };
    probe.src = "/icons/icon-192.png";

    return () => {
      active = false;
      probe.onload = null;
      probe.onerror = null;
    };
  }, [avatarUrl, bootstrapStatus, forceQrImageFallback, qrAvatarFailed]);

  const qrCenterImageSrc = useMemo(() => {
    if (forceQrImageFallback === "none") {
      return undefined;
    }

    if (forceQrImageFallback === "logo") {
      return "/icons/icon-192.png";
    }

    if (qrLogoFailed) {
      return undefined;
    }

    if (avatarUrl && !qrAvatarFailed) {
      return avatarUrl;
    }

    return "/icons/icon-192.png";
  }, [avatarUrl, forceQrImageFallback, qrAvatarFailed, qrLogoFailed]);

  const qrCenterImageKind = qrCenterImageSrc
    ? qrCenterImageSrc === avatarUrl && avatarUrl
      ? "avatar"
      : "logo"
    : "none";

  const qrImageSettings = qrCenterImageSrc
    ? { src: qrCenterImageSrc, height: 44, width: 44, excavate: true }
    : undefined;

  const copyLink = async () => {
    if (bootstrapStatus !== "ready" || !shareUrl) return;

    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success(t("share.copied"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  return (
    <FullScreenLayout title={t("share.title")}>
      <div className="flex flex-col items-center p-4">
        <div
          data-testid="share-card"
          className="w-full max-w-sm rounded-[28px] border bg-card p-5 shadow-sm"
        >
          <div className="flex flex-col items-center gap-4 text-center">
            {cardAvatarSrc ? (
              <img
                data-testid="share-card-avatar-image"
                src={cardAvatarSrc}
                alt={resolvedDisplayName}
                onError={() => setCardAvatarFailed(true)}
                className="h-20 w-20 rounded-[24px] object-cover"
              />
            ) : (
              <div data-testid="share-card-avatar-fallback">
                <ChatAvatar
                  pubKey={publicKey?.trim() || "remi"}
                  name={resolvedDisplayName}
                  size="lg"
                />
              </div>
            )}

            <div className="space-y-2">
              <p className="text-xl font-semibold break-all">{resolvedDisplayName}</p>
              {bio ? <p data-testid="share-card-bio">{bio}</p> : null}
              <p data-testid="share-card-tagline">{t("share.description")}</p>
              <p className="text-sm text-muted-foreground">{t("share.subtitle")}</p>
            </div>
          </div>

          <div className="mt-5 min-h-[260px]">
            {bootstrapStatus === "loading" ? (
              <p data-testid="share-loading" className="text-sm text-muted-foreground text-center">
                {t("share.bootstrapping")}
              </p>
            ) : null}

            {bootstrapStatus === "error" ? (
              <p data-testid="share-error" className="text-sm text-destructive text-center">
                {t("share.bootstrapError")}
              </p>
            ) : null}

            {bootstrapStatus === "ready" && shareUrl ? (
              <Card>
                <CardContent className="flex justify-center p-5">
                  <div data-testid="share-qr-wrapper" data-center-image-kind={qrCenterImageKind}>
                    <QRCodeSVG
                      value={shareUrl}
                      size={220}
                      level="H"
                      imageSettings={qrImageSettings}
                    />
                  </div>
                </CardContent>
              </Card>
            ) : (
              <div
                data-testid="share-card-placeholder"
                className="h-[220px] rounded-2xl border border-dashed"
              />
            )}
          </div>

          {bootstrapStatus === "ready" && shareUrl ? (
            <div
              data-testid="share-link"
              className="mt-4 text-center text-xs font-mono break-all text-muted-foreground"
            >
              {shareUrl}
            </div>
          ) : null}

          <Button
            className="mt-4 w-full"
            onClick={copyLink}
            disabled={bootstrapStatus !== "ready" || !shareUrl}
          >
            {t("share.copyLink")}
          </Button>
        </div>
      </div>
    </FullScreenLayout>
  );
}
