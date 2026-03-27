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
    await page.addInitScript(() => {
      window.localStorage.setItem("i18nextLng", "zh");
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url, window.location.origin);

        if (request.method === "GET" && /\/api\/[^/]+\/profile$/.test(url.pathname)) {
          return new Response(
            JSON.stringify({
              data: {
                displayName: "分享测试用户",
                bio: "用于验证分享卡片的稳定文案。",
                hasAvatar: false,
                avatarVersion: null,
                updatedAt: 1711234567890,
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        return originalFetch(input, init);
      };
    });
    await page.goto("/share");
    await page.getByTestId("share-card").waitFor({ timeout: 10000 });
  });

  test("shows the personal share card, qr code, and public profile link", async ({ page }) => {
    await expect(page.getByText("来 ReMi 链接我")).toBeVisible();
    await expect(page.getByTestId("share-card")).toBeVisible();
    await expect(page.getByTestId("share-qr-wrapper")).toBeVisible();
    await expect(page.getByRole("button", { name: "复制链接" })).toBeEnabled();
    await expect(page.getByTestId("share-link")).toContainText("/profile/");
    await expect(page.getByTestId("share-loading")).toHaveCount(0);
    await expect(page.getByTestId("share-error")).toHaveCount(0);
  });
});
