import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { imageSize } from "image-size";
import { pwaManifest } from "../../src/pwa/manifest";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../../public");

function resolvePublicAsset(src: string) {
  return path.join(publicDir, src.replace(/^\//, ""));
}

function readImageSize(src: string) {
  return imageSize(fs.readFileSync(resolvePublicAsset(src)));
}

describe("generated PWA assets", () => {
  it("creates every icon and screenshot referenced by the manifest", () => {
    for (const asset of [...pwaManifest.icons, ...(pwaManifest.screenshots ?? [])]) {
      expect(fs.existsSync(resolvePublicAsset(asset.src)), `${asset.src} should exist`).toBe(true);
    }
  });

  it("matches declared icon sizes", () => {
    for (const icon of pwaManifest.icons) {
      const size = readImageSize(icon.src);
      expect(`${size.width}x${size.height}`).toBe(icon.sizes);
    }
  });

  it("matches declared screenshot sizes", () => {
    for (const screenshot of pwaManifest.screenshots ?? []) {
      const size = readImageSize(screenshot.src);
      expect(`${size.width}x${size.height}`).toBe(screenshot.sizes);
    }
  });

  it("keeps the mobile screenshot narrow and the desktop screenshot wide", () => {
    const mobile = readImageSize("/screenshots/install-mobile.png");
    const desktop = readImageSize("/screenshots/install-desktop-wide.png");

    expect((mobile.height ?? 0) > (mobile.width ?? 0)).toBe(true);
    expect((desktop.width ?? 0) > (desktop.height ?? 0)).toBe(true);
  });
});
