# Avatar Crop Fix Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current avatar crop interaction with a `react-easy-crop` based flow so the square crop box is always fully covered, users can pan the full source under that crop area, resize the effective crop with a slider, and export exactly the selected crop region.

**Architecture:** Keep the existing settings upload flow and dialog shell, but swap the crop interaction layer in `AvatarCropDialog` to `react-easy-crop`. Treat `croppedAreaPixels` as the only export truth, update `avatar-editor` to consume explicit pixel crop rectangles, and cover the exporter plus dialog integration with focused tests.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, `react-easy-crop`

---

## File Map

- Modify: `packages/web/package.json` - add `react-easy-crop`
- Modify: `package-lock.json` - track the new dependency
- Modify: `packages/web/src/components/profile/AvatarCropDialog.tsx` - replace crop UI and wire slider + `croppedAreaPixels`
- Modify: `packages/web/src/lib/avatar-editor.ts` - accept explicit crop rectangle and export from it
- Modify: `packages/web/test/lib/avatar-editor.test.ts` - lock exporter contract to explicit crop rectangles
- Modify: `packages/web/test/components/profile/AvatarCropDialog.test.tsx` - extend existing dialog crop interaction coverage
- Create: `e2e/avatar-crop.spec.ts` - browser-level acceptance for drag + slider + export behavior

## Chunk 1: Exporter Contract

### Task 1: Lock explicit crop rectangle behavior

**Files:**

- Modify: `packages/web/test/lib/avatar-editor.test.ts`
- Modify: `packages/web/src/lib/avatar-editor.ts`

- [ ] **Step 0: Add the new dependency**

Run: `npm install --workspace @remi/web react-easy-crop`
Expected: `packages/web/package.json` and `package-lock.json` update cleanly.

- [ ] **Step 1: Write the failing test**

```ts
it("exports from the provided pixel crop rectangle", async () => {
  const result = await exportCroppedAvatar({
    image,
    cropAreaPixels: { x: 123, y: 45, width: 320, height: 321 },
    size: 512,
  });

  expect(result.type).toBe("image/webp");
  expect(drawImage).toHaveBeenCalledWith(image, 123, 45, 320, 321, 0, 0, 512, 512);
});

it("rounds and clamps pixel crop rectangles once before export", async () => {
  await exportCroppedAvatar({
    image,
    cropAreaPixels: { x: -2.4, y: 899.6, width: 500.8, height: 20.2 },
    size: 512,
  });

  expect(drawImage).toHaveBeenCalledWith(image, 0, 880, 501, 20, 0, 0, 512, 512);
});

it("caps width and height when a crop overflows the right or bottom edge", async () => {
  // explicit rect near the lower-right corner, expect x/y clamped first and width/height capped to remaining source bounds
});

it("exports landscape, portrait, and edge crop rectangles without center fallback", async () => {
  // cover wide image, tall image, and explicit corner crop rectangles
});

it("still exports small images with explicit crop rectangles", async () => {
  // 40x40 image, explicit full-image crop, expect success
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm exec vitest run packages/web/test/lib/avatar-editor.test.ts`
Expected: FAIL because `cropAreaPixels` is unsupported and exporter still derives crop from `crop + zoom + cropSize`.

- [ ] **Step 3: Write minimal implementation**

```ts
export interface AvatarCropAreaPixels {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExportCroppedAvatarInput {
  image: CanvasImageSource;
  cropAreaPixels: AvatarCropAreaPixels;
  size: number;
  maxBytes?: number;
  minSize?: number;
}
```

```ts
const cropRect = resolveCropRect(input.cropAreaPixels, input.image);
context.drawImage(
  input.image,
  cropRect.x,
  cropRect.y,
  cropRect.width,
  cropRect.height,
  0,
  0,
  dimension,
  dimension,
);
```

```ts
function resolveCropRect(cropAreaPixels: AvatarCropAreaPixels, image: CanvasImageSource) {
  // one-shot round + clamp against image dimensions
  // clamp x/y first, then cap width/height to imageWidth - x and imageHeight - y
  // reject or normalize non-positive sizes before drawImage
}
```

The old `crop + zoom + cropSize` derivation must be deleted, not kept as a fallback path.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm exec vitest run packages/web/test/lib/avatar-editor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package-lock.json packages/web/package.json packages/web/src/lib/avatar-editor.ts packages/web/test/lib/avatar-editor.test.ts
git commit -m "fix(web): use explicit avatar crop rectangles"
```

## Chunk 2: Dialog Interaction

### Task 2: Add failing integration tests for crop dialog

**Files:**

- Modify: `packages/web/test/components/profile/AvatarCropDialog.test.tsx`
- Modify: `packages/web/src/components/profile/AvatarCropDialog.tsx`

- [ ] **Step 1: Write the failing tests**

```ts
it("renders the crop dialog with slider-driven zoom and confirms using croppedAreaPixels", async () => {
  render(<AvatarCropDialog open file={file} onConfirm={onConfirm} onCancel={onCancel} />);

  expect(screen.getByLabelText(/zoom/i)).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

  expect(exportCroppedAvatar).toHaveBeenCalledWith(
    expect.objectContaining({
      cropAreaPixels: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    }),
  );
});
```

```ts
it("starts centered at minZoom with the full image visible in the crop context", () => {
  // assert deterministic initial zoom state and confirm readiness wiring only
  // baseline rule: crop box must always be fully covered; empty crop-box space is never allowed
});

it("changes the exported crop area when the zoom slider moves right", async () => {
  // render, move slider, confirm, assert exported width/height shrink
});

it("keeps landscape and portrait images mapped to exported croppedAreaPixels", async () => {
  // cover both aspect ratios through mocked croppedAreaPixels wiring
});

it("uses the latest croppedAreaPixels after repeated drag + zoom state updates", async () => {
  // assert repeated state updates still pass latest croppedAreaPixels to exporter
});

it("resets confirm readiness on dialog reopen or file change", async () => {
  // confirm disabled again until source image + first non-null croppedAreaPixels are ready
});
```

Do not delete existing submit/cancel/error coverage in `packages/web/test/components/profile/AvatarCropDialog.test.tsx`; extend that file in place.
Keep Vitest scope limited to state/wiring assertions (`minZoom` default, slider updates `zoom`, confirm passes `croppedAreaPixels`, error/disable states). Move all geometry/interaction fidelity checks to Playwright.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm exec vitest run packages/web/test/components/profile/AvatarCropDialog.test.tsx`
Expected: FAIL because dialog still uses the old pointer-driven custom crop surface and no `react-easy-crop` slider flow.

- [ ] **Step 3: Write minimal implementation**

```ts
<Cropper
  image={previewUrl}
  crop={crop}
  zoom={zoom}
  aspect={1}
  objectFit="cover"
  restrictPosition
  onCropChange={setCrop}
  onZoomChange={setZoom}
  onCropComplete={(_, croppedAreaPixels) => setCropAreaPixels(croppedAreaPixels)}
/>
```

```ts
const [cropAreaPixels, setCropAreaPixels] = useState<Area | null>(null);
// clear cropAreaPixels on dialog reopen/file change
// keep a decoded export source image (HTMLImageElement or ImageBitmap) separate from cropper UI state
// disable confirm until both export source load and first non-null onCropComplete populate readiness

const [zoom, setZoom] = useState(1);
// baseline rule: no empty crop-box space is ever allowed, including tiny images
// compute minZoom from the export source natural dimensions so the image fully covers the square crop area in both axes
// default zoom = minZoom and derive maxZoom from that baseline
const maxZoom = Math.max(DEFAULT_MAX_ZOOM, minZoom);
```

```ts
<input
  aria-label={t("settings.avatarCropZoom")}
  type="range"
  min={minZoom}
  max={maxZoom}
  step="0.01"
  value={zoom}
  onChange={(event) => setZoom(Number(event.target.value))}
/>
```

In Vitest, mock `react-easy-crop` and drive `onCropChange` / `onZoomChange` / `onCropComplete` deterministically. Keep real drag/zoom interaction verification for Playwright only.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm exec vitest run packages/web/test/components/profile/AvatarCropDialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/profile/AvatarCropDialog.tsx packages/web/test/components/profile/AvatarCropDialog.test.tsx
git commit -m "fix(web): replace avatar crop dialog interaction"
```

## Chunk 3: Verification

### Task 3: Run targeted verification and clean up

**Files:**

- Modify: `packages/web/src/components/profile/AvatarCropDialog.tsx`
- Modify: `packages/web/src/lib/avatar-editor.ts`
- Modify: `packages/web/test/lib/avatar-editor.test.ts`
- Modify: `packages/web/test/components/profile/AvatarCropDialog.test.tsx`

- [ ] **Step 1: Run targeted tests together**

Run: `npm exec vitest run packages/web/test/lib/avatar-editor.test.ts packages/web/test/components/profile/AvatarCropDialog.test.tsx`
Expected: PASS.

- [ ] **Step 2: Run package verification**

Run: `npm run build --workspace @remi/web`
Expected: PASS.

- [ ] **Step 3: Add browser-level acceptance coverage**

Create `e2e/avatar-crop.spec.ts` with 3 cases only: one landscape image, one portrait image, and one tiny `40x40` image. Each case should exercise drag + slider as applicable, assert upload happens, and verify the uploaded blob is a valid `512x512` WebP.

Implementation details for the Playwright assertion path:

- Mock the initial profile fetch, avatar upload success response, and post-upload profile refresh with `page.route(...)` so the test is fully deterministic.
- Intercept the avatar `PUT`, assert request `Content-Type` is `image/webp`, read the uploaded bytes from the request body, and decode them via a browser-side `createImageBitmap(new Blob([bytes], { type: "image/webp" }))` helper invoked from the test page to assert width/height are `512x512`.
- Use test fixtures with solid-color quadrants and corner labels, then add deterministic pixel-sampling assertions per case so the uploaded image proves the selected region moved as intended.
- For the tiny `40x40` case, assert the uploaded WebP is a full-source upscale with no transparent or padded bands.

Small-image rule for implementation and tests:

- Tiny images still use source-only cropping with no padding.
- At minimum zoom, `croppedAreaPixels` must stay fully inside the source image and expand to the largest available square crop for that source.
- For a `40x40` image, minimum zoom should yield a crop rectangle covering the full `40x40` source, which is then upscaled by the exporter to `512x512`.

- [ ] **Step 4: Run browser-level acceptance verification**

Run: `npm run test:e2e -- e2e/avatar-crop.spec.ts`
Expected: PASS with the new avatar crop Playwright coverage.

- [ ] **Step 5: Make minimal fixes if verification finds regressions**

```ts
// Only adjust crop bounds, slider defaults, or typing required to restore green builds.
```

- [ ] **Step 6: Re-run verification**

Run: `npm exec vitest run packages/web/test/lib/avatar-editor.test.ts packages/web/test/components/profile/AvatarCropDialog.test.tsx && npm run build --workspace @remi/web`
Then run: `npm run test:e2e -- e2e/avatar-crop.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package-lock.json packages/web/package.json packages/web/src/components/profile/AvatarCropDialog.tsx packages/web/src/lib/avatar-editor.ts packages/web/test/lib/avatar-editor.test.ts packages/web/test/components/profile/AvatarCropDialog.test.tsx e2e/avatar-crop.spec.ts
git commit -m "test(web): verify avatar crop flow"
```
