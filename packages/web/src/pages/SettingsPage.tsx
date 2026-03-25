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
import {
  createOwnerApiToken,
  deleteOwnerApiToken,
  listOwnerApiTokens,
  type OwnerApiToken,
} from "../lib/api-tokens";
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
  const [apiTokens, setApiTokens] = useState<OwnerApiToken[]>([]);
  const [apiTokenNote, setApiTokenNote] = useState("");
  const [createdApiTokenId, setCreatedApiTokenId] = useState<string | null>(null);
  const [hasLoadedApiTokens, setHasLoadedApiTokens] = useState(false);
  const [hasApiTokenLoadFailed, setHasApiTokenLoadFailed] = useState(false);
  const [isRetryingApiTokenLoad, setIsRetryingApiTokenLoad] = useState(false);
  const [isCreatingApiToken, setIsCreatingApiToken] = useState(false);
  const [deletingApiTokenId, setDeletingApiTokenId] = useState<string | null>(null);
  const displayNameId = useId();
  const bioId = useId();
  const avatarInputId = useId();
  const apiTokenNoteId = useId();

  const profilePath = apiClient.ownerPath("/profile");
  const avatarPath = apiClient.ownerPath("/profile/avatar");
  const avatarUrl = profile.hasAvatar ? buildAvatarUrl(publicKey, profile.avatarVersion) : null;
  const isProfileReady = hasLoadedProfile;

  useEffect(() => {
    void refreshProfile();
  }, []);

  useEffect(() => {
    void refreshApiTokens();
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

  const refreshApiTokens = async ({
    showErrorToast = true,
  }: { showErrorToast?: boolean } = {}): Promise<boolean> => {
    try {
      const items = await listOwnerApiTokens(apiClient);
      setApiTokens(items);
      setHasLoadedApiTokens(true);
      setHasApiTokenLoadFailed(false);
      return true;
    } catch {
      setHasApiTokenLoadFailed(true);
      if (showErrorToast) {
        toast.error(t("settings.apiTokenLoadError"));
      }
      return false;
    }
  };

  const handleRetryApiTokenLoad = async () => {
    setIsRetryingApiTokenLoad(true);

    try {
      await refreshApiTokens();
    } finally {
      setIsRetryingApiTokenLoad(false);
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

  const handleCreateApiToken = async () => {
    const note = apiTokenNote.trim();
    if (!note) {
      return;
    }

    setIsCreatingApiToken(true);

    try {
      const createdToken = await createOwnerApiToken(apiClient, { note });
      setCreatedApiTokenId(createdToken.id);
      setApiTokenNote("");
      setApiTokens((current) => [
        {
          id: createdToken.id,
          tokenPrefix: createdToken.id,
          note: createdToken.note,
          createdAt: createdToken.createdAt,
        },
        ...current,
      ]);
      toast.success(t("settings.apiTokenCreated"));
    } catch {
      toast.error(t("settings.apiTokenCreateError"));
    } finally {
      setIsCreatingApiToken(false);
    }
  };

  const handleDeleteApiToken = async (id: string) => {
    setDeletingApiTokenId(id);

    try {
      await deleteOwnerApiToken(apiClient, id);
      setApiTokens((current) => current.filter((item) => item.id !== id));
      setCreatedApiTokenId((current) => (current === id ? null : current));
      toast.success(t("settings.apiTokenDeleted"));
    } catch {
      toast.error(t("settings.apiTokenDeleteError"));
    } finally {
      setDeletingApiTokenId((current) => (current === id ? null : current));
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

        <Card>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <div className="text-sm font-medium">{t("settings.apiTokens")}</div>
              <div className="text-xs text-muted-foreground">
                {t("settings.apiTokensDescription")}
              </div>
            </div>

            {hasApiTokenLoadFailed && !hasLoadedApiTokens ? (
              <div className="space-y-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                <p className="text-sm text-destructive">{t("settings.apiTokenLoadError")}</p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleRetryApiTokenLoad()}
                  disabled={isRetryingApiTokenLoad}
                >
                  {t("settings.retryApiTokenLoad")}
                </Button>
              </div>
            ) : null}

            <div className="space-y-2">
              <label htmlFor={apiTokenNoteId} className="text-sm font-medium">
                {t("settings.apiTokenNote")}
              </label>
              <div className="flex gap-2">
                <Input
                  id={apiTokenNoteId}
                  value={apiTokenNote}
                  placeholder={t("settings.apiTokenNotePlaceholder")}
                  onChange={(event) => setApiTokenNote(event.target.value)}
                  disabled={isCreatingApiToken}
                />
                <Button
                  type="button"
                  onClick={handleCreateApiToken}
                  disabled={!apiTokenNote.trim() || isCreatingApiToken}
                >
                  {t("settings.createApiToken")}
                </Button>
              </div>
            </div>

            {createdApiTokenId ? (
              <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <div className="text-sm font-medium">{t("settings.apiTokenCreatedTitle")}</div>
                <div className="text-xs text-muted-foreground">
                  {t("settings.apiTokenCreatedDescription")}
                </div>
                <div className="break-all rounded bg-muted p-2 font-mono text-xs">
                  {createdApiTokenId}
                </div>
              </div>
            ) : null}

            <div className="space-y-2">
              {hasLoadedApiTokens && apiTokens.length === 0 ? (
                <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                  {t("settings.apiTokensEmpty")}
                </div>
              ) : null}

              {apiTokens.map((token) => (
                <div
                  key={token.id}
                  className="flex items-start justify-between gap-3 rounded-lg border p-3"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="text-sm font-medium break-words">{token.note}</div>
                    <div className="font-mono text-xs text-muted-foreground">{token.id}</div>
                    <time
                      className="block text-xs text-muted-foreground"
                      dateTime={token.createdAt}
                    >
                      {token.createdAt}
                    </time>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => void handleDeleteApiToken(token.id)}
                    disabled={deletingApiTokenId === token.id}
                  >
                    {t("settings.deleteApiToken")}
                  </Button>
                </div>
              ))}
            </div>
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
