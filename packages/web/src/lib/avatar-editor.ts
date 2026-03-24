const WEBP_MIME_TYPE = "image/webp";
const ACCEPTED_STATIC_AVATAR_TYPES = ["image/png", "image/jpeg", WEBP_MIME_TYPE] as const;
const EXPORT_QUALITY_STEPS = [0.92, 0.85, 0.75, 0.65, 0.5, 0.4] as const;

export interface AvatarCrop {
  x: number;
  y: number;
}

export interface ExportCroppedAvatarInput {
  image: CanvasImageSource;
  crop: AvatarCrop;
  zoom: number;
  cropSize: number;
  size: number;
  maxBytes?: number;
  minSize?: number;
}

export async function validateAvatarFile(file: File): Promise<File> {
  if (file.type === "image/gif") {
    throw new Error("GIF avatars are not supported");
  }

  if (
    !ACCEPTED_STATIC_AVATAR_TYPES.includes(
      file.type as (typeof ACCEPTED_STATIC_AVATAR_TYPES)[number],
    )
  ) {
    throw new Error("Avatar file must be PNG, JPEG, or WebP");
  }

  return file;
}

export async function exportCroppedAvatar(input: ExportCroppedAvatarInput): Promise<Blob> {
  const cropRect = resolveCropRect(input);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Canvas 2D context is unavailable");
  }

  const dimensionSteps = buildDimensionSteps(input.size, input.minSize ?? 128);

  for (const dimension of dimensionSteps) {
    canvas.width = dimension;
    canvas.height = dimension;
    context.drawImage(
      input.image,
      cropRect.sourceX,
      cropRect.sourceY,
      cropRect.sourceSize,
      cropRect.sourceSize,
      0,
      0,
      dimension,
      dimension,
    );

    for (const quality of EXPORT_QUALITY_STEPS) {
      const blob = await canvasToBlob(canvas, WEBP_MIME_TYPE, quality);
      if (!blob) {
        throw new Error("Avatar export failed");
      }

      if (!input.maxBytes || blob.size <= input.maxBytes) {
        return blob;
      }
    }
  }

  throw new Error(
    `Avatar export could not be reduced under the size limit of ${input.maxBytes} bytes`,
  );
}

function resolveCropRect(input: ExportCroppedAvatarInput) {
  const { width: sourceWidth, height: sourceHeight } = getImageDimensions(input.image);
  const zoom = Number.isFinite(input.zoom) && input.zoom > 0 ? input.zoom : 1;
  const cropSize = Math.max(1, input.cropSize);
  const sourceSize = Math.min(cropSize / zoom, sourceWidth, sourceHeight);
  const centeredX = (sourceWidth - sourceSize) / 2;
  const centeredY = (sourceHeight - sourceSize) / 2;

  return {
    sourceX: clamp(centeredX - input.crop.x / zoom, 0, sourceWidth - sourceSize),
    sourceY: clamp(centeredY - input.crop.y / zoom, 0, sourceHeight - sourceSize),
    sourceSize,
  };
}

function getImageDimensions(image: CanvasImageSource) {
  const width = getNumericProperty(image, ["naturalWidth", "videoWidth", "width"]);
  const height = getNumericProperty(image, ["naturalHeight", "videoHeight", "height"]);

  if (!width || !height) {
    throw new Error("Avatar image dimensions are unavailable");
  }

  return { width, height };
}

function getNumericProperty(target: CanvasImageSource, keys: string[]): number {
  const record = target as unknown as Record<string, unknown>;

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return 0;
}

function buildDimensionSteps(size: number, minSize: number): number[] {
  const clampedSize = Math.max(1, Math.round(size));
  const clampedMinSize = Math.max(1, Math.min(Math.round(minSize), clampedSize));
  const steps = [1, 0.875, 0.75, 0.625, 0.5, 0.375, 0.25].map((factor) =>
    Math.max(clampedMinSize, Math.round(clampedSize * factor)),
  );

  return [...new Set([clampedSize, ...steps, clampedMinSize])].sort((left, right) => right - left);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });
}

export { ACCEPTED_STATIC_AVATAR_TYPES, WEBP_MIME_TYPE };
