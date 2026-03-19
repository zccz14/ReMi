import { test, expect } from "@playwright/test";

test.describe("Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Wait for app to initialize (auth provider loads crypto keys from IndexedDB)
    await page.waitForSelector("nav", { timeout: 10000 });
  });

  test("dashboard loads", async ({ page }) => {
    // The nav should be visible after auth initialization
    await expect(page.locator("nav")).toBeVisible();
  });

  test("navigate to interview", async ({ page }) => {
    await page.locator('nav a[href="/interview"]').click();
    await expect(page).toHaveURL(/\/interview/);
  });

  test("navigate to anchors", async ({ page }) => {
    await page.locator('nav a[href="/anchors"]').click();
    await expect(page).toHaveURL(/\/anchors/);
  });

  test("navigate to settings", async ({ page }) => {
    await page.locator('nav a[href="/settings"]').click();
    await expect(page).toHaveURL(/\/settings/);
  });
});
