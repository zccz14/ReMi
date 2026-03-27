# PWA Installability Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收敛到唯一 manifest 真源，并补齐可安装图标、截图与描述元数据，让 ReMi 的 PWA 安装性检查通过。

**Architecture:** 以 `vite-plugin-pwa` 生成的 `manifest.webmanifest` 作为唯一 manifest 真源，把 manifest 数据收拢到一个可测试的 TypeScript 模块。图标与安装截图由一个可重复执行的 Python 脚本生成到 `public/`，再通过测试与构建产物校验确保资源、manifest 与最终 HTML 一致。

**Tech Stack:** Vite 6, React 19, vite-plugin-pwa, Vitest, Node.js scripts with Sharp

---

## 文件结构

- Create: `packages/web/src/pwa/manifest.ts` — 唯一 PWA manifest 数据源，导出描述、icons、screenshots 元数据
- Create: `packages/web/test/pwa/manifest.test.ts` — 校验 manifest 关键字段、icons、screenshots 结构
- Create: `packages/web/test/pwa/assets.test.ts` — 校验 manifest 引用的静态资源存在且尺寸匹配
- Create: `packages/web/scripts/generate-pwa-assets.mjs` — 用 Node + Sharp 生成 192/512 图标和移动端/桌面端 install screenshots
- Modify: `packages/web/vite.config.ts` — 将 `VitePWA` 接到 `src/pwa/manifest.ts`，保留单一 manifest 来源
- Modify: `packages/web/package.json` — 增加受控的 PWA 资产生成命令
- Modify: `packages/web/index.html` — 移除手写 manifest link，避免 build 后出现两个 `rel="manifest"`
- Delete: `packages/web/public/manifest.json` — 清理旧的第二份 manifest 来源
- Create: `packages/web/public/icons/icon-192.png` — 生成后的真实 192x192 PNG
- Create: `packages/web/public/icons/icon-512.png` — 生成后的真实 512x512 PNG
- Create: `packages/web/public/screenshots/install-mobile.png` — 移动端安装截图
- Create: `packages/web/public/screenshots/install-desktop-wide.png` — 桌面端宽屏安装截图

## Chunk 1: 单一 Manifest 真源与元数据测试

### Task 1: 建立可测试的 manifest 模块并移除重复链接

**Files:**

- Create: `packages/web/src/pwa/manifest.ts`
- Create: `packages/web/test/pwa/manifest.test.ts`
- Modify: `packages/web/vite.config.ts`
- Modify: `packages/web/index.html`
- Delete: `packages/web/public/manifest.json`

命令约定：本 Task 中所有命令都在仓库根目录 `/Users/zccz14/Projects/ReMi` 执行；`--workspace @remi/web` 依赖 `packages/web/package.json` 中已存在的 workspace 名称 `@remi/web`。

- [ ] **Step 1: 写一个失败的 manifest 测试**

```ts
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
});
```

- [ ] **Step 2: 运行测试，确认它先失败**

Run: `npx vitest run packages/web/test/pwa/manifest.test.ts --config packages/web/vite.config.ts`

Expected: FAIL，原因应指向缺失的 `pwaManifest` 模块或重复 manifest 来源仍未移除。

- [ ] **Step 3: 写最小 manifest 模块实现**

```ts
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
```

- [ ] **Step 4: 把 Vite PWA 插件改成使用唯一 manifest 真源**

Update `packages/web/vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";
import { pwaManifest } from "./src/pwa/manifest";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: pwaManifest,
      includeAssets: ["icons/icon-192.png", "icons/icon-512.png"],
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg}"],
        navigateFallback: "/index.html",
        runtimeCaching: [
          {
            urlPattern: /^https?:\/\/.*\/api\//,
            handler: "NetworkOnly",
          },
        ],
      },
    }),
  ],
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/helpers/setup.ts"],
  },
});
```

- [ ] **Step 5: 移除重复 manifest 来源**

Update `packages/web/index.html` by removing the static manifest link:

```html
<!doctype html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ReMi - 鉴心</title>
    <meta name="theme-color" content="#1a1a2e" />
    <link rel="apple-touch-icon" href="/icons/icon-192.png" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Then delete `packages/web/public/manifest.json`.

- [ ] **Step 6: 运行测试，确认 manifest 模块变绿**

Run: `npx vitest run packages/web/test/pwa/manifest.test.ts --config packages/web/vite.config.ts`

Expected: PASS with `4 passed`.

- [ ] **Step 7: 构建一次，确认最终只剩一个 manifest link**

Run: `npm run build --workspace @remi/web`

Expected: build succeeds and emits `dist/manifest.webmanifest`.

- [ ] **Step 8: 检查构建产物中的 manifest 引用数量**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
html = Path("packages/web/dist/index.html").read_text()
count = html.count('rel="manifest"')
print(count)
assert count == 1, f"expected exactly one manifest link, got {count}"
PY
```

Expected: prints `1` and exits successfully.

- [ ] **Step 9: 校验构建产物里的 manifest 内容来自 `pwaManifest`**

Run:

```bash
python3 - <<'PY'
import json
from pathlib import Path

manifest = json.loads(Path("packages/web/dist/manifest.webmanifest").read_text())
assert manifest["id"] == "/"
assert manifest["name"] == "ReMi - 鉴心"
assert manifest["description"] == "AI 个人分身，持续学习你的认知方式并代表你对话与行动。"
assert manifest["icons"][0]["src"] == "/icons/icon-192.png"
assert manifest["screenshots"][1]["form_factor"] == "wide"
print("manifest content verified")
PY
```

Expected: prints `manifest content verified` and exits successfully.

Note: 本 Chunk 只把 manifest metadata 和唯一真源打通；资源文件存在性与像素尺寸在 Chunk 2 继续收口。

- [ ] **Step 10: Commit**

```bash
git add packages/web/src/pwa/manifest.ts packages/web/test/pwa/manifest.test.ts packages/web/vite.config.ts packages/web/index.html packages/web/public/manifest.json
git commit -m "fix: unify PWA manifest source"
```

## Chunk 2: 生成图标与安装截图并做资源校验

### Task 2: 用可重复脚本生成 PWA 资产

**Files:**

- Create: `packages/web/scripts/generate-pwa-assets.mjs`
- Create: `packages/web/test/pwa/assets.test.ts`
- Create: `packages/web/public/icons/icon-192.png`
- Create: `packages/web/public/icons/icon-512.png`
- Create: `packages/web/public/screenshots/install-mobile.png`
- Create: `packages/web/public/screenshots/install-desktop-wide.png`
- Modify: `packages/web/package.json`

前置条件：Chunk 1 已完成，`packages/web/src/pwa/manifest.ts` 已存在并通过测试。

命令约定：本 Task 中所有命令都在仓库根目录 `/Users/zccz14/Projects/ReMi` 执行。

- [ ] **Step 1: 写一个失败的资源校验测试**

```ts
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { imageSize } from "image-size";
import { fileURLToPath } from "node:url";
import { pwaManifest } from "../../src/pwa/manifest";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../../public");

function resolvePublicAsset(src: string) {
  return path.join(publicDir, src.replace(/^\//, ""));
}

describe("generated PWA assets", () => {
  it("creates every icon and screenshot referenced by the manifest", () => {
    for (const asset of [...pwaManifest.icons, ...(pwaManifest.screenshots ?? [])]) {
      const filePath = resolvePublicAsset(asset.src);
      expect(fs.existsSync(filePath), `${asset.src} should exist`).toBe(true);
    }
  });

  it("matches declared icon sizes", () => {
    for (const icon of pwaManifest.icons) {
      const filePath = resolvePublicAsset(icon.src);
      const size = imageSize(filePath);
      expect(`${size.width}x${size.height}`).toBe(icon.sizes);
    }
  });

  it("keeps the mobile screenshot narrow and the desktop screenshot wide", () => {
    const mobile = imageSize(resolvePublicAsset("/screenshots/install-mobile.png"));
    const desktop = imageSize(resolvePublicAsset("/screenshots/install-desktop-wide.png"));

    expect(mobile.height).toBeGreaterThan(mobile.width ?? 0);
    expect(desktop.width).toBeGreaterThan(desktop.height ?? 0);
  });

  it("matches declared screenshot sizes", () => {
    for (const screenshot of pwaManifest.screenshots ?? []) {
      const filePath = resolvePublicAsset(screenshot.src);
      const size = imageSize(filePath);
      expect(`${size.width}x${size.height}`).toBe(screenshot.sizes);
    }
  });
});
```

- [ ] **Step 2: 安装测试依赖并为资产脚本接入 Node 工具链**

Run: `npm install --workspace @remi/web --save-dev image-size sharp`

Update `packages/web/package.json` scripts:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "generate:pwa-assets": "node scripts/generate-pwa-assets.mjs"
  }
}
```

- [ ] **Step 3: 运行测试，确认它先失败**

Run: `npx vitest run packages/web/test/pwa/assets.test.ts --config packages/web/vite.config.ts`

Expected: FAIL because the generated asset files do not exist yet.

- [ ] **Step 4: 添加可重复执行的资产生成脚本**

Create `packages/web/scripts/generate-pwa-assets.mjs`:

```js
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const publicDir = path.join(root, "public");
const iconsDir = path.join(publicDir, "icons");
const screenshotsDir = path.join(publicDir, "screenshots");

await fs.mkdir(iconsDir, { recursive: true });
await fs.mkdir(screenshotsDir, { recursive: true });

const colors = {
  navy: "#1a1a2e",
  blue: "#2563eb",
  sky: "#dbeafe",
  white: "#ffffff",
  slate: "#0f172a",
  muted: "#64748b",
  border: "#cbd5e1",
};

function iconSvg(size) {
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="${size}" height="${size}" rx="${size * 0.22}" fill="${colors.navy}"/>
      <rect x="${size * 0.12}" y="${size * 0.12}" width="${size * 0.76}" height="${size * 0.76}" rx="${size * 0.18}" fill="${colors.blue}"/>
      <rect x="${size * 0.22}" y="${size * 0.22}" width="${size * 0.56}" height="${size * 0.56}" rx="${size * 0.14}" fill="${colors.white}"/>
      <rect x="${size * 0.34}" y="${size * 0.26}" width="${size * 0.16}" height="${size * 0.48}" rx="${size * 0.08}" fill="${colors.slate}"/>
      <path d="M ${size * 0.48} ${size * 0.5} L ${size * 0.7} ${size * 0.26} L ${size * 0.8} ${size * 0.36} L ${size * 0.58} ${size * 0.6} L ${size * 0.8} ${size * 0.74} L ${size * 0.7} ${size * 0.84}" stroke="${colors.slate}" stroke-width="${size * 0.08}" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
}

function mobileScreenshotSvg(width, height) {
  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="${colors.white}"/>
      <rect width="${width}" height="220" fill="${colors.navy}"/>
      <rect x="80" y="70" width="260" height="80" rx="28" fill="${colors.white}"/>
      <rect x="80" y="290" width="460" height="70" rx="24" fill="${colors.slate}"/>
      <rect x="80" y="410" width="620" height="40" rx="20" fill="${colors.muted}"/>
      <rect x="60" y="560" width="1122" height="1400" rx="56" fill="#f8fafc" stroke="${colors.border}" stroke-width="6"/>
      <rect x="120" y="680" width="902" height="230" rx="42" fill="${colors.blue}"/>
      <rect x="156" y="716" width="626" height="36" rx="14" fill="${colors.white}"/>
      <rect x="156" y="776" width="694" height="36" rx="14" fill="${colors.white}"/>
      <rect x="156" y="836" width="546" height="36" rx="14" fill="${colors.white}"/>
      <rect x="220" y="980" width="902" height="340" rx="42" fill="#e2e8f0"/>
      <rect x="256" y="1016" width="626" height="36" rx="14" fill="${colors.slate}"/>
      <rect x="256" y="1076" width="694" height="36" rx="14" fill="${colors.slate}"/>
      <rect x="256" y="1136" width="546" height="36" rx="14" fill="${colors.slate}"/>
      <rect x="120" y="1390" width="902" height="230" rx="42" fill="${colors.blue}"/>
      <rect x="156" y="1426" width="626" height="36" rx="14" fill="${colors.white}"/>
      <rect x="156" y="1486" width="694" height="36" rx="14" fill="${colors.white}"/>
      <rect x="156" y="1546" width="546" height="36" rx="14" fill="${colors.white}"/>
      <rect x="60" y="2060" width="1122" height="220" rx="48" fill="#eff6ff" stroke="#bfdbfe" stroke-width="4"/>
      <rect x="110" y="2120" width="882" height="40" rx="18" fill="${colors.blue}"/>
      <rect x="110" y="2190" width="712" height="38" rx="18" fill="#60a5fa"/>
    </svg>`;
}

function desktopScreenshotSvg(width, height) {
  const cards = [540, 840, 1140]
    .map(
      (top) => `
        <rect x="720" y="${top}" width="1980" height="250" rx="36" fill="#f8fafc" stroke="${colors.border}" stroke-width="4"/>
        <rect x="780" y="${top + 54}" width="320" height="42" rx="16" fill="${colors.slate}"/>
        <rect x="780" y="${top + 136}" width="1740" height="32" rx="14" fill="${colors.muted}"/>
        <rect x="780" y="${top + 188}" width="1580" height="32" rx="14" fill="#94a3b8"/>
      `,
    )
    .join("\n");

  const nav = [430, 600, 770, 940]
    .map(
      (top) => `
        <rect x="110" y="${top}" width="360" height="120" rx="28" fill="${colors.white}"/>
        <rect x="150" y="${top + 35}" width="180" height="35" rx="14" fill="${colors.slate}"/>
      `,
    )
    .join("\n");

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#f8fafc"/>
      <rect width="${width}" height="132" fill="${colors.navy}"/>
      <rect x="80" y="36" width="380" height="56" rx="20" fill="${colors.white}"/>
      <rect x="60" y="200" width="460" height="1520" rx="48" fill="#e2e8f0"/>
      <rect x="120" y="280" width="180" height="50" rx="18" fill="${colors.slate}"/>
      ${nav}
      <rect x="610" y="200" width="2190" height="1520" rx="48" fill="${colors.white}"/>
      <rect x="720" y="280" width="460" height="60" rx="20" fill="${colors.slate}"/>
      <rect x="720" y="390" width="840" height="40" rx="18" fill="${colors.muted}"/>
      ${cards}
    </svg>`;
}

async function writePng(filePath, svg, width, height) {
  await sharp(Buffer.from(svg)).resize(width, height).png().toFile(filePath);
}

await writePng(path.join(iconsDir, "icon-192.png"), iconSvg(192), 192, 192);
await writePng(path.join(iconsDir, "icon-512.png"), iconSvg(512), 512, 512);
await writePng(
  path.join(screenshotsDir, "install-mobile.png"),
  mobileScreenshotSvg(1242, 2688),
  1242,
  2688,
);
await writePng(
  path.join(screenshotsDir, "install-desktop-wide.png"),
  desktopScreenshotSvg(2880, 1800),
  2880,
  1800,
);

console.log("generated PWA assets");
```

- [ ] **Step 5: 运行脚本生成资源**

Run: `npm run generate:pwa-assets --workspace @remi/web`

Expected: prints `generated PWA assets` and writes the four PNG files.

- [ ] **Step 6: 运行资源测试，确认变绿**

Run: `npx vitest run packages/web/test/pwa/assets.test.ts --config packages/web/vite.config.ts`

Expected: PASS with `4 passed`.

- [ ] **Step 7: 运行 manifest + assets 测试，确认都绿**

Run: `npx vitest run packages/web/test/pwa/manifest.test.ts packages/web/test/pwa/assets.test.ts --config packages/web/vite.config.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/web/scripts/generate-pwa-assets.mjs packages/web/test/pwa/assets.test.ts packages/web/public/icons/icon-192.png packages/web/public/icons/icon-512.png packages/web/public/screenshots/install-mobile.png packages/web/public/screenshots/install-desktop-wide.png package-lock.json packages/web/package.json
git commit -m "fix: add installable PWA assets"
```

## Chunk 3: 构建产物与最终验收

### Task 3: 做最终 build 验证并记录 Chromium 验收点

**Files:**

- Modify: `docs/superpowers/specs/2026-03-27-pwa-installability-design.md` (only if implementation reveals a spec drift; otherwise no code changes)

前置条件：Chunk 1 已完成唯一 manifest 真源接线；Chunk 2 已生成 icon 与 screenshot 资源。

命令约定：本 Task 中所有命令都在仓库根目录 `/Users/zccz14/Projects/ReMi` 执行。

- [ ] **Step 1: 运行完整前端构建**

Run: `npm run build --workspace @remi/web`

Expected: PASS and emits `packages/web/dist/manifest.webmanifest`, `packages/web/dist/sw.js`, and `packages/web/dist/index.html`.

- [ ] **Step 2: 验证最终 manifest 字段与资源引用**

Run:

```bash
python3 - <<'PY'
import json
from pathlib import Path

manifest = json.loads(Path("packages/web/dist/manifest.webmanifest").read_text())
assert manifest["id"] == "/"
assert manifest["description"] == "AI 个人分身，持续学习你的认知方式并代表你对话与行动。"
icons = {item["src"]: item for item in manifest["icons"]}
shots = {item["src"]: item for item in manifest["screenshots"]}
assert "/icons/icon-192.png" in icons
assert "/icons/icon-512.png" in icons
assert "/screenshots/install-mobile.png" in shots
assert shots["/screenshots/install-mobile.png"].get("form_factor") is None
assert shots["/screenshots/install-desktop-wide.png"]["form_factor"] == "wide"
print("manifest verified")
PY
```

Expected: prints `manifest verified`.

- [ ] **Step 3: 验证最终 HTML 只保留一个 manifest link**

Run:

```bash
python3 - <<'PY'
from html.parser import HTMLParser
from pathlib import Path

class ManifestLinkCounter(HTMLParser):
    def __init__(self):
        super().__init__()
        self.count = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "link" and attrs.get("rel") == "manifest":
            self.count += 1

parser = ManifestLinkCounter()
parser.feed(Path("packages/web/dist/index.html").read_text())
assert parser.count == 1, f"expected 1 manifest link, got {parser.count}"
print("single manifest link verified")
PY
```

Expected: prints `single manifest link verified`.

- [ ] **Step 4: 手动 Chromium 验收**

Run the preview server:

```bash
npm run preview --workspace @remi/web -- --host 127.0.0.1 --port 4173
```

Then open `http://127.0.0.1:4173` in Chromium.

Verify in Application > Manifest:

- `id` is `/`
- description is present
- 192 and 512 icons are recognized
- one mobile screenshot is shown with no `form_factor`
- one desktop screenshot is shown with `form_factor: wide`

Verify in Elements or View Source:

- the loaded document contains exactly one `rel="manifest"` link

- [ ] **Step 5: Commit**

```bash
git add packages/web docs/superpowers/specs/2026-03-27-pwa-installability-design.md
git commit -m "fix: improve PWA installability metadata"
```
