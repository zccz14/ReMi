import { expect, test, type Page } from "@playwright/test";

type UploadedAvatar = {
  contentType: string;
  bytes: number[];
};

type ImageFixtureOptions = {
  width: number;
  height: number;
  name: string;
};

const QUADRANT_COLORS = {
  topLeft: [220, 60, 60] as const,
  topRight: [60, 190, 90] as const,
  bottomLeft: [60, 110, 220] as const,
  bottomRight: [240, 210, 60] as const,
};

const CORNER_MARKERS = {
  topLeft: [16, 16, 16] as const,
  topRight: [245, 245, 245] as const,
  bottomLeft: [235, 0, 235] as const,
  bottomRight: [0, 235, 235] as const,
};

type DecodedUpload = {
  width: number;
  height: number;
  samples: Record<string, [number, number, number, number]>;
};

test.describe("avatar crop flow", () => {
  test("uploads a dragged + zoomed landscape crop as 512x512 webp", async ({ page }) => {
    const upload = await installAvatarRoutes(page);

    await page.goto("/settings");
    await page.waitForURL(/\/settings/);

    await uploadAvatarFixture(page, { width: 480, height: 240, name: "landscape.png" });
    await setZoomToMax(page);
    await dragCrop(page, { dx: 88, dy: 88 });
    await page.getByRole("button", { name: /confirm|确认/i }).click();

    const uploaded = await upload.finished;
    expect(uploaded.contentType).toBe("image/webp");

    const decoded = await decodeUploadedWebp(page, uploaded.bytes);
    expect(decoded.width).toBe(512);
    expect(decoded.height).toBe(512);
    expectColor(decoded.samples.topLeftMarker, CORNER_MARKERS.topLeft, 32);
    expectColor(decoded.samples.bottomLeftMarker, CORNER_MARKERS.bottomLeft, 32);
    expectColor(decoded.samples.topRightMarker, QUADRANT_COLORS.topLeft, 36);
    expectColor(decoded.samples.bottomRightMarker, QUADRANT_COLORS.bottomLeft, 36);
    expect(decoded.samples.center[0]).toBeLessThan(160);
    expect(decoded.samples.center[2]).toBeGreaterThan(120);
    await expect(page.getByText(/avatar updated|头像已更新/i)).toBeVisible();
  });

  test("uploads a dragged + zoomed portrait crop as 512x512 webp", async ({ page }) => {
    const upload = await installAvatarRoutes(page);

    await page.goto("/settings");
    await page.waitForURL(/\/settings/);

    await uploadAvatarFixture(page, { width: 240, height: 480, name: "portrait.png" });
    await setZoomToMax(page);
    await dragCrop(page, { dx: -88, dy: -88 });
    await page.getByRole("button", { name: /confirm|确认/i }).click();

    const uploaded = await upload.finished;
    expect(uploaded.contentType).toBe("image/webp");

    const decoded = await decodeUploadedWebp(page, uploaded.bytes);
    expect(decoded.width).toBe(512);
    expect(decoded.height).toBe(512);
    expectColor(decoded.samples.topLeftMarker, CORNER_MARKERS.topLeft, 32);
    expectColor(decoded.samples.topRightMarker, CORNER_MARKERS.topRight, 32);
    expectColor(decoded.samples.bottomLeftMarker, QUADRANT_COLORS.topLeft, 36);
    expectColor(decoded.samples.bottomRightMarker, QUADRANT_COLORS.topRight, 36);
    expect(decoded.samples.center[1]).toBeGreaterThan(120);
    expect(decoded.samples.center[2]).toBeLessThan(120);
    await expect(page.getByText(/avatar updated|头像已更新/i)).toBeVisible();
  });

  test("uploads a tiny 40x40 avatar as a full-source upscale without padding", async ({ page }) => {
    const upload = await installAvatarRoutes(page);

    await page.goto("/settings");
    await page.waitForURL(/\/settings/);

    await uploadAvatarFixture(page, { width: 40, height: 40, name: "tiny.png" });
    await page.getByRole("button", { name: /confirm|确认/i }).click();

    const uploaded = await upload.finished;
    expect(uploaded.contentType).toBe("image/webp");

    const decoded = await decodeUploadedWebp(page, uploaded.bytes);
    expect(decoded.width).toBe(512);
    expect(decoded.height).toBe(512);
    expectColor(decoded.samples.topLeftMarker, CORNER_MARKERS.topLeft, 32);
    expectColor(decoded.samples.topRightMarker, CORNER_MARKERS.topRight, 32);
    expectColor(decoded.samples.bottomLeftMarker, CORNER_MARKERS.bottomLeft, 32);
    expectColor(decoded.samples.bottomRightMarker, CORNER_MARKERS.bottomRight, 32);
    expect(decoded.samples.topLeftMarker[3]).toBe(255);
    expect(decoded.samples.topRightMarker[3]).toBe(255);
    expect(decoded.samples.bottomLeftMarker[3]).toBe(255);
    expect(decoded.samples.bottomRightMarker[3]).toBe(255);
    expect(decoded.samples.center[3]).toBe(255);
    await expect(page.getByText(/avatar updated|头像已更新/i)).toBeVisible();
  });
});

async function installAvatarRoutes(page: Page) {
  let profileFetchCount = 0;
  let latestUpload: UploadedAvatar | null = null;
  let resolveUpload!: (upload: UploadedAvatar) => void;
  const finished = new Promise<UploadedAvatar>((resolve) => {
    resolveUpload = resolve;
  });

  await page.route(/\/api\/[^/]+\/profile$/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }

    profileFetchCount += 1;
    const hasAvatar = profileFetchCount > 1 && latestUpload !== null;

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          displayName: "Avatar Tester",
          bio: "Crop flow",
          hasAvatar,
          avatarVersion: hasAvatar ? profileFetchCount : null,
          updatedAt: 1711234567890,
        },
      }),
    });
  });

  await page.route(/\/api\/[^/]+\/profile\/avatar(?:\?.*)?$/, async (route) => {
    const request = route.request();

    if (request.method() === "PUT") {
      const bytes = request.postDataBuffer();
      if (!bytes) {
        throw new Error("Expected avatar upload body bytes");
      }

      latestUpload = {
        contentType: request.headers()["content-type"] ?? "",
        bytes: [...bytes],
      };

      resolveUpload(latestUpload);
      await route.fulfill({ status: 204, body: "" });
      return;
    }

    if (request.method() === "GET" && latestUpload) {
      await route.fulfill({
        status: 200,
        contentType: "image/webp",
        body: Buffer.from(latestUpload.bytes),
      });
      return;
    }

    await route.fulfill({ status: 404, body: "" });
  });

  return { finished };
}

async function uploadAvatarFixture(page: Page, options: ImageFixtureOptions) {
  await page.locator('input[type="file"]').setInputFiles({
    name: options.name,
    mimeType: "image/png",
    buffer: await createQuadrantImageBuffer(page, options.width, options.height),
  });

  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".reactEasyCrop_Container")).toBeVisible();
}

async function createQuadrantImageBuffer(page: Page, width: number, height: number) {
  const bytes = await page.evaluate(
    async ({ width, height, quadrantColors, cornerMarkers }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Missing 2d context");
      }

      const halfWidth = width / 2;
      const halfHeight = height / 2;
      context.fillStyle = `rgb(${quadrantColors.topLeft.join(",")})`;
      context.fillRect(0, 0, halfWidth, halfHeight);
      context.fillStyle = `rgb(${quadrantColors.topRight.join(",")})`;
      context.fillRect(halfWidth, 0, halfWidth, halfHeight);
      context.fillStyle = `rgb(${quadrantColors.bottomLeft.join(",")})`;
      context.fillRect(0, halfHeight, halfWidth, halfHeight);
      context.fillStyle = `rgb(${quadrantColors.bottomRight.join(",")})`;
      context.fillRect(halfWidth, halfHeight, halfWidth, halfHeight);

      const markerSize = Math.max(8, Math.round(Math.min(width, height) * 0.18));
      context.fillStyle = `rgb(${cornerMarkers.topLeft.join(",")})`;
      context.fillRect(0, 0, markerSize, markerSize);
      context.fillStyle = `rgb(${cornerMarkers.topRight.join(",")})`;
      context.fillRect(width - markerSize, 0, markerSize, markerSize);
      context.fillStyle = `rgb(${cornerMarkers.bottomLeft.join(",")})`;
      context.fillRect(0, height - markerSize, markerSize, markerSize);
      context.fillStyle = `rgb(${cornerMarkers.bottomRight.join(",")})`;
      context.fillRect(width - markerSize, height - markerSize, markerSize, markerSize);

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) {
        throw new Error("Could not encode png fixture");
      }

      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    },
    { width, height, quadrantColors: QUADRANT_COLORS, cornerMarkers: CORNER_MARKERS },
  );

  return Buffer.from(bytes);
}

async function setZoomToMax(page: Page) {
  const slider = page.getByRole("slider", { name: /zoom|缩放/i });
  const max = await slider.evaluate((element) => Number((element as HTMLInputElement).max));
  await slider.evaluate((element, value) => {
    const input = element as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, max);
}

async function dragCrop(page: Page, { dx, dy }: { dx: number; dy: number }) {
  const cropper = page.locator(".reactEasyCrop_Container");
  const box = await cropper.boundingBox();
  if (!box) {
    throw new Error("Cropper surface is not visible");
  }

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 16 });
  await page.mouse.up();
}

async function decodeUploadedWebp(page: Page, bytes: number[]): Promise<DecodedUpload> {
  return page.evaluate(async (uploadedBytes) => {
    const blob = new Blob([new Uint8Array(uploadedBytes)], { type: "image/webp" });
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Missing 2d context");
    }

    context.drawImage(bitmap, 0, 0);

    const sampleAt = (x: number, y: number) => {
      const pixel = context.getImageData(x, y, 1, 1).data;
      return [pixel[0], pixel[1], pixel[2], pixel[3]] as [number, number, number, number];
    };

    const edge = 48;
    const center = Math.floor(bitmap.width / 2);

    return {
      width: bitmap.width,
      height: bitmap.height,
      samples: {
        topLeftMarker: sampleAt(edge, edge),
        topRightMarker: sampleAt(bitmap.width - edge, edge),
        bottomLeftMarker: sampleAt(edge, bitmap.height - edge),
        bottomRightMarker: sampleAt(bitmap.width - edge, bitmap.height - edge),
        center: sampleAt(center, center),
      },
    };
  }, bytes);
}

function expectColor(
  actual: [number, number, number, number],
  expected: readonly [number, number, number],
  tolerance: number,
) {
  expect(actual[0]).toBeGreaterThanOrEqual(expected[0] - tolerance);
  expect(actual[0]).toBeLessThanOrEqual(expected[0] + tolerance);
  expect(actual[1]).toBeGreaterThanOrEqual(expected[1] - tolerance);
  expect(actual[1]).toBeLessThanOrEqual(expected[1] + tolerance);
  expect(actual[2]).toBeGreaterThanOrEqual(expected[2] - tolerance);
  expect(actual[2]).toBeLessThanOrEqual(expected[2] + tolerance);
  expect(actual[3]).toBe(255);
}
