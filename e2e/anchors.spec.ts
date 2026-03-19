import { test, expect } from "@playwright/test";

test.describe("Anchors Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/anchors");
    await page.waitForSelector("nav", { timeout: 10000 });
  });

  test("page loads with search input", async ({ page }) => {
    // Search input should be visible after page loads
    await expect(page.locator("input")).toBeVisible();
  });

  test("add button shows form", async ({ page }) => {
    // The add button contains "+" text
    const addButton = page.locator("button", { hasText: "+" });
    // Wait for it to appear (loading may take time, or may show immediately if API fails)
    await addButton.waitFor({ timeout: 10000 });
    await addButton.click();

    // After clicking, a form with a textarea for the answer should appear
    await expect(page.locator("textarea")).toBeVisible();
  });

  test("search input is interactive", async ({ page }) => {
    const searchInput = page.locator("input").first();
    await searchInput.waitFor({ timeout: 10000 });
    await searchInput.fill("test query");
    await expect(searchInput).toHaveValue("test query");
  });
});
