import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pwaManifest } from "../../src/pwa/manifest";

const here = path.dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = path.resolve(here, "../../index.html");
const viteConfigPath = path.resolve(here, "../../vite.config.ts");

describe("pwaManifest", () => {
  it("defines the install metadata required by Chromium", () => {
    expect(pwaManifest.id).toBe("/");
    expect(pwaManifest.name).toBe("ReMi - 鉴心");
    expect(pwaManifest.short_name).toBe("ReMi");
    expect(pwaManifest.description).toBe("AI 个人分身，持续学习你的认知方式并代表你对话与行动。");
    expect(pwaManifest.start_url).toBe("/");
    expect(pwaManifest.display).toBe("standalone");
    expect(pwaManifest.theme_color).toBe("#1a1a2e");
    expect(pwaManifest.background_color).toBe("#ffffff");
  });

  it("declares installable icons and richer install screenshots", () => {
    expect(pwaManifest.icons).toEqual([
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ]);

    expect(pwaManifest.screenshots).toEqual([
      {
        src: "/screenshots/install-mobile.png",
        sizes: "1242x2688",
        type: "image/png",
      },
      {
        src: "/screenshots/install-desktop-wide.png",
        sizes: "2880x1800",
        type: "image/png",
        form_factor: "wide",
      },
    ]);
  });

  it("relies on vite-plugin-pwa as the only manifest injector", () => {
    const indexHtml = fs.readFileSync(indexHtmlPath, "utf8");
    expect(indexHtml).not.toContain('rel="manifest"');
  });

  it("wires vite-plugin-pwa to the shared manifest module", () => {
    const viteConfig = fs.readFileSync(viteConfigPath, "utf8");
    expect(viteConfig).toContain('import { pwaManifest } from "./src/pwa/manifest"');
    expect(viteConfig).toContain("manifest: pwaManifest");
  });

  it("keeps the manifest available during local development", () => {
    const viteConfig = fs.readFileSync(viteConfigPath, "utf8");
    expect(viteConfig).toContain("devOptions: {");
    expect(viteConfig).toContain("enabled: true");
  });
});
