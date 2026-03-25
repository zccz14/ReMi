import { useEffect, useRef, useState } from "react";
import Cropper, { type Area, type Point } from "react-easy-crop";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { exportCroppedAvatar } from "@/lib/avatar-editor";

type Props = {
  open: boolean;
  file: File | null;
  onConfirm: (blob: Blob) => void | Promise<void>;
  onCancel: () => void;
};

const DEFAULT_CROP: Point = { x: 0, y: 0 };
const EXPORT_SIZE = 512;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ZOOM = 3;
const DEFAULT_MIN_ZOOM = 1;
const DEFAULT_CROP_BOX_SIZE = 192;
const CROP_BOX_SIZE = {
  width: DEFAULT_CROP_BOX_SIZE,
  height: DEFAULT_CROP_BOX_SIZE,
} as const;

export function AvatarCropDialog({ open, file, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  const cropAreaPixelsRef = useRef<Area | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [exportSource, setExportSource] = useState<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<Point>(DEFAULT_CROP);
  const [zoom, setZoom] = useState(DEFAULT_MIN_ZOOM);
  const [minZoom, setMinZoom] = useState(DEFAULT_MIN_ZOOM);
  const [cropAreaPixels, setCropAreaPixels] = useState<Area | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setPreviewUrl(null);
    setExportSource(null);
    setCrop(DEFAULT_CROP);
    setZoom(DEFAULT_MIN_ZOOM);
    setMinZoom(DEFAULT_MIN_ZOOM);
    setCropAreaPixels(null);
    cropAreaPixelsRef.current = null;
    setErrorMessage(null);

    if (!file || !open) {
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file, open]);

  const maxZoom = Math.max(DEFAULT_MAX_ZOOM, minZoom);
  const clampedZoom = clamp(zoom, minZoom, maxZoom);
  const isReady = exportSource !== null && cropAreaPixels !== null;

  useEffect(() => {
    if (zoom !== clampedZoom) {
      setZoom(clampedZoom);
    }
  }, [clampedZoom, zoom]);

  if (!open || !file) {
    return null;
  }

  const handleConfirm = async () => {
    const latestCropAreaPixels = cropAreaPixelsRef.current;
    if (!exportSource || !latestCropAreaPixels || isSubmitting) {
      return;
    }

    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      let blob: Blob;

      try {
        blob = await exportCroppedAvatar({
          image: exportSource,
          cropAreaPixels: latestCropAreaPixels,
          size: EXPORT_SIZE,
          maxBytes: MAX_UPLOAD_BYTES,
        });
      } catch {
        setErrorMessage(t("settings.avatarCropExportError"));
        return;
      }

      try {
        await onConfirm(blob);
      } catch {
        setErrorMessage(t("settings.avatarUploadError"));
        return;
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !isSubmitting) {
      onCancel();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("settings.avatarCropTitle")}</DialogTitle>
          <DialogDescription>{t("settings.avatarCropDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div
            data-testid="avatar-crop-surface"
            className="relative flex h-64 w-64 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted/30"
          >
            {previewUrl ? (
              <Cropper
                image={previewUrl}
                crop={crop}
                cropSize={CROP_BOX_SIZE}
                zoom={clampedZoom}
                minZoom={minZoom}
                maxZoom={maxZoom}
                aspect={1}
                objectFit="contain"
                restrictPosition
                onCropChange={(nextCrop) => {
                  setErrorMessage(null);
                  setCrop(nextCrop);
                }}
                onZoomChange={(nextZoom) => {
                  setErrorMessage(null);
                  setZoom(nextZoom);
                }}
                onCropComplete={(_, nextCropAreaPixels) => {
                  setErrorMessage(null);
                  cropAreaPixelsRef.current = nextCropAreaPixels;
                  setCropAreaPixels(nextCropAreaPixels);
                }}
              />
            ) : null}
          </div>

          {previewUrl ? (
            <img
              data-testid="avatar-export-source"
              src={previewUrl}
              alt=""
              aria-hidden="true"
              className="hidden"
              onLoad={(event) => {
                const target = event.currentTarget;
                const nextMinZoom = getMinZoomBaseline({
                  imageWidth: target.naturalWidth,
                  imageHeight: target.naturalHeight,
                  cropWidth: CROP_BOX_SIZE.width,
                  cropHeight: CROP_BOX_SIZE.height,
                });

                setErrorMessage(null);
                setExportSource(target);
                setCrop(DEFAULT_CROP);
                setMinZoom(nextMinZoom);
                setZoom(nextMinZoom);
              }}
              onError={() => {
                cropAreaPixelsRef.current = null;
                setExportSource(null);
                setCropAreaPixels(null);
                setCrop(DEFAULT_CROP);
                setMinZoom(DEFAULT_MIN_ZOOM);
                setZoom(DEFAULT_MIN_ZOOM);
                setErrorMessage(t("settings.avatarFileUnsupported"));
              }}
            />
          ) : null}

          <p className="text-xs text-muted-foreground">{file.name}</p>

          <label className="grid gap-2 text-sm">
            <span>{t("settings.avatarCropZoom")}</span>
            <input
              aria-label={t("settings.avatarCropZoom")}
              type="range"
              min={minZoom}
              max={maxZoom}
              step="0.01"
              value={clampedZoom}
              onChange={(event) => {
                setErrorMessage(null);
                setZoom(Number(event.target.value));
              }}
            />
          </label>

          {errorMessage ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={!isReady || isSubmitting}>
            {isSubmitting ? t("settings.avatarCropSubmitting") : t("common.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function getMinZoomBaseline({
  imageWidth,
  imageHeight,
  cropWidth,
  cropHeight,
}: {
  imageWidth: number;
  imageHeight: number;
  cropWidth: number;
  cropHeight: number;
}) {
  if (imageWidth <= 0 || imageHeight <= 0 || cropWidth <= 0 || cropHeight <= 0) {
    return DEFAULT_MIN_ZOOM;
  }

  return Math.max(cropWidth / imageWidth, cropHeight / imageHeight);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
