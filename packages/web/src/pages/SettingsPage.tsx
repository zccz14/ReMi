import { useEffect, useId, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useAuth } from "../hooks/use-auth";
import { ChatAvatar } from "../components/chat/ChatAvatar";
import { AvatarCropDialog } from "../components/profile/AvatarCropDialog";
import { FullScreenLayout } from "../components/layout/FullScreenLayout";
import { Card, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { validateAvatarFile } from "../lib/avatar-editor";
import { buildAvatarUrl, emptyPublicProfile, type PublicProfile } from "../lib/profile";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const { publicKey, keyStore, apiClient } = useAuth();
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [importValue, setImportValue] = useState("");
  const [profile, setProfile] = useState<PublicProfile>(emptyPublicProfile);
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [isCropOpen, setIsCropOpen] = useState(false);
  const [hasLoadedProfile, setHasLoadedProfile] = useState(false);
  const [hasProfileLoadFailed, setHasProfileLoadFailed] = useState(false);
  const [isRetryingProfileLoad, setIsRetryingProfileLoad] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [isDeletingAvatar, setIsDeletingAvatar] = useState(false);
  const displayNameId = useId();
  const bioId = useId();
  const avatarInputId = useId();

  const profilePath = apiClient.ownerPath("/profile");
  const avatarPath = apiClient.ownerPath("/profile/avatar");
  const avatarUrl = profile.hasAvatar ? buildAvatarUrl(publicKey, profile.avatarVersion) : null;
  const isProfileReady = hasLoadedProfile;

  useEffect(() => {
    void refreshProfile();
  }, []);

  const refreshProfile = async ({
    showErrorToast = true,
  }: { showErrorToast?: boolean } = {}): Promise<boolean> => {
    try {
      const response = await apiClient.get<{ data: PublicProfile }>(profilePath);
      applyProfile(response.data);
      setHasLoadedProfile(true);
      setHasProfileLoadFailed(false);
      return true;
    } catch {
      setHasProfileLoadFailed(true);
      if (showErrorToast) {
        toast.error(t("settings.profileLoadError"));
      }
      return false;
    }
  };

  const handleRetryProfileLoad = async () => {
    setIsRetryingProfileLoad(true);

    try {
      await refreshProfile();
    } finally {
      setIsRetryingProfileLoad(false);
    }
  };

  const applyProfile = (nextProfile: PublicProfile) => {
    setProfile(nextProfile);
    setDisplayName(nextProfile.displayName);
    setBio(nextProfile.bio);
  };

  const copyPublicKey = async () => {
    try {
      await navigator.clipboard.writeText(publicKey);
      toast.success(t("settings.copied"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  const handleExport = () => setShowPrivateKey(!showPrivateKey);

  const handleImport = async () => {
    if (!importValue.trim()) return;
    try {
      await keyStore.importPrivateKey(importValue.trim());
      window.location.reload();
    } catch {
      toast.error(t("common.error"));
    }
  };

  const handleSaveProfile = async () => {
    if (!hasLoadedProfile) {
      return;
    }

    setIsSavingProfile(true);

    try {
      const response = await apiClient.put<{ data: PublicProfile }>(profilePath, {
        displayName,
        bio,
      });
      applyProfile(response.data);
      toast.success(t("settings.profileSaved"));
    } catch {
      toast.error(t("settings.profileSaveError"));
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleAvatarSelection = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";

    if (!file || !isProfileReady) {
      return;
    }

    try {
      await validateAvatarFile(file);
      setAvatarFile(file);
      setIsCropOpen(true);
    } catch {
      toast.error(
        t(
          file.type === "image/gif"
            ? "settings.avatarGifUnsupported"
            : "settings.avatarFileUnsupported",
        ),
      );
    }
  };

  const handleAvatarCropCancel = () => {
    setIsCropOpen(false);
    setAvatarFile(null);
  };

  const handleAvatarCropConfirm = async (blob: Blob) => {
    if (!isProfileReady) {
      return;
    }

    setIsUploadingAvatar(true);

    try {
      await apiClient.putBinary(avatarPath, blob, "image/webp");
      const refreshed = await refreshProfile({ showErrorToast: false });
      if (!refreshed) {
        toast.error(t("settings.avatarUploadError"));
        return;
      }
      toast.success(t("settings.avatarUploadSuccess"));
      handleAvatarCropCancel();
    } catch {
      toast.error(t("settings.avatarUploadError"));
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  const handleDeleteAvatar = async () => {
    if (!isProfileReady) {
      return;
    }

    setIsDeletingAvatar(true);

    try {
      await apiClient.del(avatarPath);
      const refreshed = await refreshProfile({ showErrorToast: false });
      if (!refreshed) {
        toast.error(t("settings.avatarDeleteError"));
        return;
      }
      toast.success(t("settings.avatarDeleteSuccess"));
    } catch {
      toast.error(t("settings.avatarDeleteError"));
    } finally {
      setIsDeletingAvatar(false);
    }
  };

  return (
    <FullScreenLayout title={t("settings.title")}>
      <div className="p-4 space-y-6 overflow-y-auto h-full">
        <Card>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <div className="text-sm font-medium">{t("settings.publicProfile")}</div>
              <div className="text-xs text-muted-foreground">
                {t("settings.publicProfileDescription")}
              </div>
            </div>

            {hasProfileLoadFailed && !isProfileReady ? (
              <div className="space-y-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                <p className="text-sm text-destructive">{t("settings.profileLoadError")}</p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleRetryProfileLoad()}
                  disabled={isRetryingProfileLoad}
                >
                  {t("settings.retryProfileLoad")}
                </Button>
              </div>
            ) : null}

            <div className="flex items-center gap-4">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt={t("settings.avatarPreview")}
                  className="size-18 rounded-xl object-cover border"
                />
              ) : (
                <ChatAvatar pubKey={publicKey} name={displayName || undefined} size="lg" />
              )}

              <div className="space-y-2">
                <div className="space-y-1">
                  <label htmlFor={avatarInputId} className="text-sm font-medium">
                    {t("settings.uploadAvatar")}
                  </label>
                  <Input
                    id={avatarInputId}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={handleAvatarSelection}
                    disabled={!isProfileReady || isUploadingAvatar}
                  />
                </div>

                {profile.hasAvatar ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={handleDeleteAvatar}
                    disabled={!isProfileReady || isDeletingAvatar}
                  >
                    {t("settings.deleteAvatar")}
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor={displayNameId} className="text-sm font-medium">
                {t("settings.displayName")}
              </label>
              <Input
                id={displayNameId}
                value={displayName}
                maxLength={40}
                disabled={!isProfileReady}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor={bioId} className="text-sm font-medium">
                {t("settings.bio")}
              </label>
              <Textarea
                id={bioId}
                value={bio}
                maxLength={280}
                disabled={!isProfileReady}
                onChange={(event) => setBio(event.target.value)}
              />
            </div>

            <Button
              type="button"
              onClick={handleSaveProfile}
              disabled={!hasLoadedProfile || isSavingProfile}
            >
              {t("settings.saveProfile")}
            </Button>
          </CardContent>
        </Card>

        {/* Public Key */}
        <Card>
          <CardContent className="space-y-2">
            <div className="text-sm font-medium">{t("settings.publicKey")}</div>
            <div className="text-xs font-mono break-all text-muted-foreground">{publicKey}</div>
            <Button variant="link" size="sm" onClick={copyPublicKey}>
              {t("settings.copy")}
            </Button>
          </CardContent>
        </Card>

        {/* Export */}
        <Card>
          <CardContent className="space-y-2">
            <Button variant="link" size="sm" onClick={handleExport}>
              {t("settings.exportKey")}
            </Button>
            {showPrivateKey && (
              <div>
                <div className="text-xs text-destructive mb-1">{t("settings.exportWarning")}</div>
                <div className="text-xs font-mono break-all bg-muted p-2 rounded">
                  {keyStore.exportPrivateKey()}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Import */}
        <Card>
          <CardContent className="space-y-2">
            <div className="text-sm font-medium">{t("settings.importKey")}</div>
            <Input
              className="font-mono text-xs"
              placeholder={t("settings.importPlaceholder")}
              value={importValue}
              onChange={(e) => setImportValue(e.target.value)}
            />
            <Button variant="link" size="sm" onClick={handleImport} disabled={!importValue.trim()}>
              {t("settings.import")}
            </Button>
          </CardContent>
        </Card>

        {/* Language */}
        <Card>
          <CardContent className="space-y-2">
            <div className="text-sm font-medium">{t("settings.language")}</div>
            <Select
              value={i18n.language}
              onValueChange={(value) => value && i18n.changeLanguage(value)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="zh">中文</SelectItem>
                <SelectItem value="en">English</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      </div>

      <AvatarCropDialog
        open={isCropOpen}
        file={avatarFile}
        onCancel={handleAvatarCropCancel}
        onConfirm={handleAvatarCropConfirm}
      />
    </FullScreenLayout>
  );
}
