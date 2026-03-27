import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const publicDir = path.join(root, "public");
const iconsDir = path.join(publicDir, "icons");
const screenshotsDir = path.join(publicDir, "screenshots");

const colors = {
  navy: "#1a1a2e",
  blue: "#2563eb",
  sky: "#dbeafe",
  white: "#ffffff",
  slate: "#0f172a",
  muted: "#64748b",
  border: "#cbd5e1",
  panel: "#f8fafc",
  panelDark: "#e2e8f0",
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
      <rect x="60" y="560" width="1122" height="1400" rx="56" fill="${colors.panel}" stroke="${colors.border}" stroke-width="6"/>
      <rect x="120" y="680" width="902" height="230" rx="42" fill="${colors.blue}"/>
      <rect x="156" y="716" width="626" height="36" rx="14" fill="${colors.white}"/>
      <rect x="156" y="776" width="694" height="36" rx="14" fill="${colors.white}"/>
      <rect x="156" y="836" width="546" height="36" rx="14" fill="${colors.white}"/>
      <rect x="220" y="980" width="902" height="340" rx="42" fill="${colors.panelDark}"/>
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
  const nav = [430, 600, 770, 940]
    .map(
      (top) => `
        <rect x="110" y="${top}" width="360" height="120" rx="28" fill="${colors.white}"/>
        <rect x="150" y="${top + 35}" width="180" height="35" rx="14" fill="${colors.slate}"/>
      `,
    )
    .join("");

  const cards = [540, 840, 1140]
    .map(
      (top) => `
        <rect x="720" y="${top}" width="1980" height="250" rx="36" fill="${colors.panel}" stroke="${colors.border}" stroke-width="4"/>
        <rect x="780" y="${top + 54}" width="320" height="42" rx="16" fill="${colors.slate}"/>
        <rect x="780" y="${top + 136}" width="1740" height="32" rx="14" fill="${colors.muted}"/>
        <rect x="780" y="${top + 188}" width="1580" height="32" rx="14" fill="#94a3b8"/>
      `,
    )
    .join("");

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="${colors.panel}"/>
      <rect width="${width}" height="132" fill="${colors.navy}"/>
      <rect x="80" y="36" width="380" height="56" rx="20" fill="${colors.white}"/>
      <rect x="60" y="200" width="460" height="1520" rx="48" fill="${colors.panelDark}"/>
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

await fs.mkdir(iconsDir, { recursive: true });
await fs.mkdir(screenshotsDir, { recursive: true });

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

process.stdout.write("generated PWA assets\n");
