import { test, expect } from "@playwright/test";

test.describe("Settings Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/settings");
    await page.waitForSelector("nav", { timeout: 10000 });
  });

  test("shows public key", async ({ page }) => {
    // The public key is displayed in a monospace element
    // Wait for auth to initialize and content to render
    const monoText = page.locator(".font-mono").first();
    await monoText.waitFor({ timeout: 10000 });
    // Public key should be a non-empty string
    const text = await monoText.textContent();
    expect(text).toBeTruthy();
    expect(text!.length).toBeGreaterThan(10);
  });
});

test.describe("Share Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/share");
    await page.waitForSelector("nav", { timeout: 10000 });
  });

  test("shows QR code and share URL", async ({ page }) => {
    // QR code is an SVG element inside a card
    const qrSvg = page.locator("svg").first();
    await qrSvg.waitFor({ timeout: 10000 });
    await expect(qrSvg).toBeVisible();

    // Share URL should contain "/s/" and the public key
    const urlText = page.locator(".font-mono");
    await urlText.waitFor({ timeout: 10000 });
    const shareUrl = await urlText.textContent();
    expect(shareUrl).toContain("/s/");
  });
});
