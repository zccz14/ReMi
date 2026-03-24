import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { exportCroppedAvatar, validateAvatarFile } from "../../src/lib/avatar-editor";

describe("avatar-editor", () => {
  const image = { width: 1200, height: 900 } as CanvasImageSource & {
    width: number;
    height: number;
  };

  let drawImage: ReturnType<typeof vi.fn>;
  let toBlobImpl: (type?: string, quality?: unknown) => Promise<Blob | null>;

  beforeEach(() => {
    drawImage = vi.fn();
    toBlobImpl = async () => new Blob([new Uint8Array(1024)], { type: "image/webp" });

    vi.stubGlobal("document", {
      createElement: vi.fn((tagName: string) => {
        if (tagName !== "canvas") {
          throw new Error(`Unexpected element: ${tagName}`);
        }

        const canvas = {
          width: 0,
          height: 0,
          getContext: vi.fn(() => ({ drawImage })),
          toBlob: vi.fn(
            async (callback: (blob: Blob | null) => void, type?: string, quality?: unknown) => {
              callback(await toBlobImpl(type, quality));
            },
          ),
        };

        return canvas as unknown as HTMLCanvasElement;
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exports from the provided pixel crop rectangle", async () => {
    const result = await exportCroppedAvatar({
      image,
      cropAreaPixels: { x: 123, y: 45, width: 320, height: 321 },
      size: 512,
    });

    expect(result.type).toBe("image/webp");
    expect(drawImage).toHaveBeenCalledWith(image, 123, 45, 320, 321, 0, 0, 512, 512);
  });

  it("rounds and clamps pixel crop rectangles once before export", async () => {
    await exportCroppedAvatar({
      image,
      cropAreaPixels: { x: -2.4, y: 899.6, width: 500.8, height: 20.2 },
      size: 512,
    });

    expect(drawImage).toHaveBeenCalledWith(image, 0, 899, 501, 1, 0, 0, 512, 512);
  });

  it("caps width and height when a crop overflows the right or bottom edge", async () => {
    await exportCroppedAvatar({
      image,
      cropAreaPixels: { x: 1189.6, y: 890.2, width: 20.4, height: 30.6 },
      size: 512,
    });

    expect(drawImage).toHaveBeenCalledWith(image, 1190, 890, 10, 10, 0, 0, 512, 512);
  });

  it("exports landscape, portrait, and edge crop rectangles without center fallback", async () => {
    const landscape = { width: 1600, height: 900 } as CanvasImageSource & {
      width: number;
      height: number;
    };
    const portrait = { width: 900, height: 1600 } as CanvasImageSource & {
      width: number;
      height: number;
    };

    await exportCroppedAvatar({
      image: landscape,
      cropAreaPixels: { x: 40, y: 20, width: 900, height: 400 },
      size: 512,
    });
    await exportCroppedAvatar({
      image: portrait,
      cropAreaPixels: { x: 25, y: 100, width: 300, height: 900 },
      size: 512,
    });
    await exportCroppedAvatar({
      image,
      cropAreaPixels: { x: 0, y: 0, width: 200, height: 250 },
      size: 512,
    });

    expect(drawImage).toHaveBeenNthCalledWith(1, landscape, 40, 20, 900, 400, 0, 0, 512, 512);
    expect(drawImage).toHaveBeenNthCalledWith(2, portrait, 25, 100, 300, 900, 0, 0, 512, 512);
    expect(drawImage).toHaveBeenNthCalledWith(3, image, 0, 0, 200, 250, 0, 0, 512, 512);
  });

  it("still exports small images with explicit crop rectangles", async () => {
    const tinyImage = { width: 40, height: 40 } as CanvasImageSource & {
      width: number;
      height: number;
    };

    const result = await exportCroppedAvatar({
      image: tinyImage,
      cropAreaPixels: { x: 0, y: 0, width: 40, height: 40 },
      size: 512,
    });

    expect(result.type).toBe("image/webp");
    expect(drawImage).toHaveBeenCalledWith(tinyImage, 0, 0, 40, 40, 0, 0, 512, 512);
  });

  it("rejects gif inputs before crop export", async () => {
    await expect(
      validateAvatarFile(new File(["gif"], "x.gif", { type: "image/gif" })),
    ).rejects.toThrow(/gif/i);
  });

  it("accepts png, jpeg, and webp static avatar inputs", async () => {
    await expect(
      Promise.all([
        validateAvatarFile(new File(["png"], "x.png", { type: "image/png" })),
        validateAvatarFile(new File(["jpg"], "x.jpg", { type: "image/jpeg" })),
        validateAvatarFile(new File(["webp"], "x.webp", { type: "image/webp" })),
      ]),
    ).resolves.toHaveLength(3);
  });

  it("rejects non-positive or invalid maxBytes before export", async () => {
    await expect(
      exportCroppedAvatar({
        image,
        cropAreaPixels: { x: 0, y: 0, width: 300, height: 300 },
        size: 1024,
        maxBytes: 0,
      }),
    ).rejects.toThrow(/maxBytes/i);

    await expect(
      exportCroppedAvatar({
        image,
        cropAreaPixels: { x: 0, y: 0, width: 300, height: 300 },
        size: 1024,
        maxBytes: Number.NaN,
      }),
    ).rejects.toThrow(/maxBytes/i);
  });

  it("reduces dimensions after quality fallback until the avatar fits the upload limit", async () => {
    toBlobImpl = async (_type, quality) => {
      const normalizedQuality = typeof quality === "number" ? quality : 0.92;
      const lastDrawImageCall = drawImage.mock.calls.at(-1);
      const renderedWidth = lastDrawImageCall?.[7];
      const size = normalizedQuality <= 0.4 && renderedWidth !== 1024 ? 180 : 400;
      return new Blob([new Uint8Array(size)], { type: "image/webp" });
    };

    const result = await exportCroppedAvatar({
      image,
      cropAreaPixels: { x: 0, y: 0, width: 300, height: 300 },
      size: 1024,
      maxBytes: 256,
    });

    expect(result.size).toBeLessThanOrEqual(256);
    expect(drawImage).toHaveBeenLastCalledWith(image, 0, 0, 300, 300, 0, 0, 896, 896);
  });

  it("fails deterministically when the avatar cannot be reduced under the limit", async () => {
    toBlobImpl = async () => new Blob([new Uint8Array(512)], { type: "image/webp" });

    await expect(
      exportCroppedAvatar({
        image,
        cropAreaPixels: { x: 0, y: 0, width: 300, height: 300 },
        size: 1024,
        maxBytes: 64,
      }),
    ).rejects.toThrow(/size/i);
  });
});
