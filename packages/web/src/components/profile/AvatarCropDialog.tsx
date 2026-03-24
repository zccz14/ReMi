import { useEffect, useMemo, useRef, useState } from "react";
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

type Crop = { x: number; y: number };
type ImageSize = { width: number; height: number };

const DEFAULT_CROP: Crop = { x: 0, y: 0 };
const CROP_SIZE = 256;
const EXPORT_SIZE = 512;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ZOOM = 3;

export function AvatarCropDialog({ open, file, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  const previewRef = useRef<HTMLImageElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const cropRef = useRef<Crop>(DEFAULT_CROP);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<ImageSize | null>(null);
  const [surfaceSize, setSurfaceSize] = useState(CROP_SIZE);
  const [crop, setCrop] = useState<Crop>(DEFAULT_CROP);
  const [zoom, setZoom] = useState(1);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setImageSize(null);
    setCrop(DEFAULT_CROP);
    cropRef.current = DEFAULT_CROP;
    setZoom(1);
    setSurfaceSize(CROP_SIZE);
    setErrorMessage(null);

    if (!file || !open) {
      setPreviewUrl(null);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file, open]);

  useEffect(() => {
    cropRef.current = crop;
  }, [crop]);

  const minZoom = useMemo(() => {
    if (!imageSize) {
      return 1;
    }

    return Math.max(1, CROP_SIZE / Math.min(imageSize.width, imageSize.height));
  }, [imageSize]);

  const maxZoom = Math.max(DEFAULT_MAX_ZOOM, minZoom);

  const clampedZoom = clamp(zoom, minZoom, maxZoom);
  const clampedCrop = useMemo(
    () => (imageSize ? clampCrop(crop, imageSize, clampedZoom) : DEFAULT_CROP),
    [crop, imageSize, clampedZoom],
  );

  useEffect(() => {
    if (zoom !== clampedZoom) {
      setZoom(clampedZoom);
    }
  }, [clampedZoom, zoom]);

  useEffect(() => {
    if (crop.x !== clampedCrop.x || crop.y !== clampedCrop.y) {
      cropRef.current = clampedCrop;
      setCrop(clampedCrop);
    }
  }, [clampedCrop, crop.x, crop.y]);

  if (!open || !file) {
    return null;
  }

  const previewStyle = imageSize
    ? buildPreviewStyle({ imageSize, crop: clampedCrop, zoom: clampedZoom, surfaceSize })
    : undefined;

  const surfaceScale = surfaceSize / CROP_SIZE;

  const handleConfirm = async () => {
    if (!previewRef.current || !imageSize || isSubmitting) {
      return;
    }

    measureSurface();
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const blob = await exportCroppedAvatar({
        image: previewRef.current,
        crop: clampedCrop,
        zoom: clampedZoom,
        cropSize: CROP_SIZE,
        size: EXPORT_SIZE,
        maxBytes: MAX_UPLOAD_BYTES,
      });

      await onConfirm(blob);
    } catch {
      setErrorMessage(t("settings.avatarCropExportError"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!imageSize) {
      return;
    }

    measureSurface();
    setErrorMessage(null);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (
      !dragState ||
      dragState.pointerId !== event.pointerId ||
      !imageSize ||
      (event.buttons & 1) !== 1
    ) {
      return;
    }

    const nextCrop = clampCrop(
      {
        x: cropRef.current.x + (event.clientX - dragState.x) / surfaceScale,
        y: cropRef.current.y + (event.clientY - dragState.y) / surfaceScale,
      },
      imageSize,
      clampedZoom,
    );

    dragStateRef.current = { ...dragState, x: event.clientX, y: event.clientY };
    cropRef.current = nextCrop;
    setCrop(nextCrop);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId === event.pointerId) {
      dragStateRef.current = null;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleLostPointerCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId === event.pointerId) {
      dragStateRef.current = null;
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
            ref={surfaceRef}
            data-testid="avatar-crop-surface"
            className="relative h-64 w-64 touch-none overflow-hidden rounded-xl border border-border bg-muted/30"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onLostPointerCapture={handleLostPointerCapture}
          >
            {previewUrl ? (
              <img
                ref={previewRef}
                src={previewUrl}
                alt={t("settings.avatarCropPreviewAlt")}
                draggable={false}
                className="absolute max-w-none select-none"
                style={previewStyle}
                onLoad={(event) => {
                  const target = event.currentTarget;
                  const nextImageSize = {
                    width: target.naturalWidth,
                    height: target.naturalHeight,
                  };

                  const nextMinZoom = Math.max(
                    1,
                    CROP_SIZE / Math.min(nextImageSize.width, nextImageSize.height),
                  );
                  const nextMaxZoom = Math.max(DEFAULT_MAX_ZOOM, nextMinZoom);

                  measureSurface();
                  setImageSize(nextImageSize);
                  setZoom((currentZoom) => clamp(currentZoom, nextMinZoom, nextMaxZoom));
                  setCrop((currentCrop) => clampCrop(currentCrop, nextImageSize, nextMinZoom));
                }}
              />
            ) : null}
            <div className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-black/10" />
          </div>

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
          <Button type="button" onClick={handleConfirm} disabled={!imageSize || isSubmitting}>
            {isSubmitting ? t("settings.avatarCropSubmitting") : t("common.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  function measureSurface() {
    const nextSize = surfaceRef.current?.getBoundingClientRect().width ?? 0;
    if (Number.isFinite(nextSize) && nextSize > 0) {
      setSurfaceSize(nextSize);
    }
  }
}

function buildPreviewStyle({
  imageSize,
  crop,
  zoom,
  surfaceSize,
}: {
  imageSize: ImageSize;
  crop: Crop;
  zoom: number;
  surfaceSize: number;
}) {
  const scale = surfaceSize / CROP_SIZE;

  return {
    width: `${imageSize.width * zoom * scale}px`,
    height: `${imageSize.height * zoom * scale}px`,
    left: `${(surfaceSize - imageSize.width * zoom * scale) / 2 + crop.x * scale}px`,
    top: `${(surfaceSize - imageSize.height * zoom * scale) / 2 + crop.y * scale}px`,
  };
}

function clampCrop(crop: Crop, imageSize: ImageSize, zoom: number): Crop {
  const maxX = Math.max(0, (imageSize.width * zoom - CROP_SIZE) / 2);
  const maxY = Math.max(0, (imageSize.height * zoom - CROP_SIZE) / 2);

  return {
    x: clamp(crop.x, -maxX, maxX),
    y: clamp(crop.y, -maxY, maxY),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
