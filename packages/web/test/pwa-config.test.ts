import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const viteConfigPath = path.resolve(here, "../vite.config.ts");

describe("vite PWA config", () => {
  it('uses registerType: "prompt" for explicit updates', () => {
    const viteConfig = fs.readFileSync(viteConfigPath, "utf8");

    expect(viteConfig).toContain('registerType: "prompt"');
  });
});
