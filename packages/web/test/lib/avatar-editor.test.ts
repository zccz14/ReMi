import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("exports a square webp avatar from crop settings", async () => {
    const result = await exportCroppedAvatar({
      image,
      crop: { x: 50, y: 0 },
      zoom: 2,
      cropSize: 300,
      size: 512,
    });

    expect(result.type).toBe("image/webp");
    expect(drawImage).toHaveBeenCalledWith(image, 500, 375, 150, 150, 0, 0, 512, 512);
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

  it("reduces quality or dimensions until the avatar fits the upload limit", async () => {
    toBlobImpl = async (_type, quality) => {
      const normalizedQuality = typeof quality === "number" ? quality : 0.92;
      const size = normalizedQuality <= 0.5 ? 180 : 400;
      return new Blob([new Uint8Array(size)], { type: "image/webp" });
    };

    const result = await exportCroppedAvatar({
      image,
      crop: { x: 0, y: 0 },
      zoom: 1,
      cropSize: 300,
      size: 1024,
      maxBytes: 256,
    });

    expect(result.size).toBeLessThanOrEqual(256);
  });

  it("fails deterministically when the avatar cannot be reduced under the limit", async () => {
    toBlobImpl = async () => new Blob([new Uint8Array(512)], { type: "image/webp" });

    await expect(
      exportCroppedAvatar({
        image,
        crop: { x: 0, y: 0 },
        zoom: 1,
        cropSize: 300,
        size: 1024,
        maxBytes: 64,
      }),
    ).rejects.toThrow(/size/i);
  });
});
