import { useEffect, useState } from "react";
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

type CanonicalCrop = {
  x: number;
  y: number;
  size: number;
};

type ImageBounds = {
  width: number;
  height: number;
};

const DEFAULT_CROP: Point = { x: 0, y: 0 };
const DEFAULT_BOUNDS: ImageBounds = { width: 0, height: 0 };
const EXPORT_SIZE = 512;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const DEFAULT_CROP_BOX_SIZE = 192;
const CROP_BOX_SIZE = {
  width: DEFAULT_CROP_BOX_SIZE,
  height: DEFAULT_CROP_BOX_SIZE,
} as const;

export const AVATAR_MIN_CROP_SIZE = 100;

export function AvatarCropDialog({ open, file, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [exportSource, setExportSource] = useState<HTMLImageElement | null>(null);
  const [imageBounds, setImageBounds] = useState<ImageBounds>(DEFAULT_BOUNDS);
  const [canonicalCrop, setCanonicalCrop] = useState<CanonicalCrop | null>(null);
  const [cropperCrop, setCropperCrop] = useState<Point>(DEFAULT_CROP);
  const [cropperZoom, setCropperZoom] = useState(1);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setPreviewUrl(null);
    setExportSource(null);
    setImageBounds(DEFAULT_BOUNDS);
    setCanonicalCrop(null);
    setCropperCrop(DEFAULT_CROP);
    setCropperZoom(1);
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

  if (!open || !file) {
    return null;
  }

  const shortEdge = getShortEdge(imageBounds.width, imageBounds.height);
  const sliderMin = AVATAR_MIN_CROP_SIZE;
  const sliderMax = Math.max(shortEdge, AVATAR_MIN_CROP_SIZE);
  const sliderValue = canonicalCrop?.size ?? sliderMax;
  const isReady = exportSource !== null && canonicalCrop !== null;

  const handleConfirm = async () => {
    if (!exportSource || !canonicalCrop || isSubmitting) {
      return;
    }

    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      let blob: Blob;

      try {
        blob = await exportCroppedAvatar({
          image: exportSource,
          cropAreaPixels: toExportPixels(
            canonicalCrop,
            exportSource.naturalWidth,
            exportSource.naturalHeight,
          ),
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
                crop={cropperCrop}
                cropSize={CROP_BOX_SIZE}
                zoom={cropperZoom}
                minZoom={CROP_BOX_SIZE.width / sliderMax}
                maxZoom={CROP_BOX_SIZE.width / sliderMin}
                aspect={1}
                objectFit="contain"
                restrictPosition
                onCropChange={(nextCrop) => {
                  setErrorMessage(null);
                  setCropperCrop(nextCrop);
                }}
                onZoomChange={(nextZoom) => {
                  setErrorMessage(null);
                  setCropperZoom(nextZoom);
                }}
                onCropComplete={(_, croppedAreaPixels) => {
                  if (imageBounds.width <= 0 || imageBounds.height <= 0) {
                    return;
                  }

                  const nextCanonicalCrop = normalizeCropCandidate({
                    candidateX: croppedAreaPixels.x,
                    candidateY: croppedAreaPixels.y,
                    candidateWidth: croppedAreaPixels.width,
                    candidateHeight: croppedAreaPixels.height,
                    imageWidth: imageBounds.width,
                    imageHeight: imageBounds.height,
                  });
                  const nextCropperState = deriveCropperStateFromCanonicalCrop(
                    nextCanonicalCrop,
                    imageBounds.width,
                    imageBounds.height,
                  );

                  setErrorMessage(null);
                  setCanonicalCrop(nextCanonicalCrop);
                  setCropperCrop(nextCropperState.crop);
                  setCropperZoom(nextCropperState.zoom);
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
                const nextBounds = {
                  width: target.naturalWidth,
                  height: target.naturalHeight,
                };
                const nextShortEdge = getShortEdge(nextBounds.width, nextBounds.height);

                setImageBounds(nextBounds);
                setErrorMessage(null);

                if (nextShortEdge < AVATAR_MIN_CROP_SIZE) {
                  setExportSource(null);
                  setCanonicalCrop(null);
                  setCropperCrop(DEFAULT_CROP);
                  setCropperZoom(1);
                  setErrorMessage(
                    t("settings.avatarCropTooSmall", {
                      size: AVATAR_MIN_CROP_SIZE,
                      defaultValue: `Image is too small. Avatar requires at least ${AVATAR_MIN_CROP_SIZE} x ${AVATAR_MIN_CROP_SIZE} pixels.`,
                    }),
                  );
                  return;
                }

                const nextCanonicalCrop = createCenteredCanonicalCrop(
                  nextBounds.width,
                  nextBounds.height,
                );
                const nextCropperState = deriveCropperStateFromCanonicalCrop(
                  nextCanonicalCrop,
                  nextBounds.width,
                  nextBounds.height,
                );

                setExportSource(target);
                setCanonicalCrop(nextCanonicalCrop);
                setCropperCrop(nextCropperState.crop);
                setCropperZoom(nextCropperState.zoom);
              }}
              onError={() => {
                setImageBounds(DEFAULT_BOUNDS);
                setExportSource(null);
                setCanonicalCrop(null);
                setCropperCrop(DEFAULT_CROP);
                setCropperZoom(1);
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
              min={sliderMin}
              max={sliderMax}
              step="1"
              value={sliderValue}
              disabled={!canonicalCrop}
              onChange={(event) => {
                if (!canonicalCrop) {
                  return;
                }

                const nextCanonicalCrop = resizeCanonicalCropFromCenter(
                  canonicalCrop,
                  Number(event.target.value),
                  imageBounds,
                );
                const nextCropperState = deriveCropperStateFromCanonicalCrop(
                  nextCanonicalCrop,
                  imageBounds.width,
                  imageBounds.height,
                );

                setErrorMessage(null);
                setCanonicalCrop(nextCanonicalCrop);
                setCropperCrop(nextCropperState.crop);
                setCropperZoom(nextCropperState.zoom);
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

function createCenteredCanonicalCrop(imageWidth: number, imageHeight: number): CanonicalCrop {
  const size = getShortEdge(imageWidth, imageHeight);

  return {
    x: (imageWidth - size) / 2,
    y: (imageHeight - size) / 2,
    size,
  };
}

export function normalizeCropCandidate(input: {
  candidateX: number;
  candidateY: number;
  candidateWidth: number;
  candidateHeight: number;
  imageWidth: number;
  imageHeight: number;
}): CanonicalCrop {
  const shortEdge = getShortEdge(input.imageWidth, input.imageHeight);
  const size = clamp(
    Math.min(input.candidateWidth, input.candidateHeight),
    AVATAR_MIN_CROP_SIZE,
    shortEdge,
  );
  const x = clamp(input.candidateX + (input.candidateWidth - size) / 2, 0, input.imageWidth - size);
  const y = clamp(
    input.candidateY + (input.candidateHeight - size) / 2,
    0,
    input.imageHeight - size,
  );

  return { x, y, size };
}

export function resizeCanonicalCropFromCenter(
  crop: CanonicalCrop,
  nextSize: number,
  bounds: ImageBounds,
): CanonicalCrop {
  const centerX = crop.x + crop.size / 2;
  const centerY = crop.y + crop.size / 2;

  return normalizeCropCandidate({
    candidateX: centerX - nextSize / 2,
    candidateY: centerY - nextSize / 2,
    candidateWidth: nextSize,
    candidateHeight: nextSize,
    imageWidth: bounds.width,
    imageHeight: bounds.height,
  });
}

export function toExportPixels(crop: CanonicalCrop, imageWidth: number, imageHeight: number): Area {
  const size = Math.max(1, Math.min(Math.floor(crop.size), getShortEdge(imageWidth, imageHeight)));

  return {
    x: clamp(Math.round(crop.x), 0, imageWidth - size),
    y: clamp(Math.round(crop.y), 0, imageHeight - size),
    width: size,
    height: size,
  };
}

export function deriveCropperStateFromCanonicalCrop(
  crop: CanonicalCrop,
  imageWidth: number,
  imageHeight: number,
) {
  const zoom = CROP_BOX_SIZE.width / crop.size;
  const imageCenterX = imageWidth / 2;
  const imageCenterY = imageHeight / 2;
  const cropCenterX = crop.x + crop.size / 2;
  const cropCenterY = crop.y + crop.size / 2;

  return {
    cropSize: CROP_BOX_SIZE,
    zoom,
    crop: {
      x: (imageCenterX - cropCenterX) * zoom,
      y: (imageCenterY - cropCenterY) * zoom,
    },
  };
}

function getShortEdge(width: number, height: number) {
  if (width <= 0 || height <= 0) {
    return 0;
  }

  return Math.min(width, height);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
