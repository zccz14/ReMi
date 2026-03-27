import type { ManifestOptions } from "vite-plugin-pwa";

export const pwaManifest = {
  id: "/",
  name: "ReMi - 鉴心",
  short_name: "ReMi",
  description: "AI 个人分身，持续学习你的认知方式并代表你对话与行动。",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#ffffff",
  theme_color: "#1a1a2e",
  icons: [
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
  ],
  screenshots: [
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
  ],
} satisfies Partial<ManifestOptions>;
