# Avatar Crop Constraints Revision Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the revised avatar crop constraints so the crop square is always fully inside the source image, starts as the maximum centered legal square, uses a `[100, shortEdge]` slider range, and rejects undersized images with a clear error.

**Architecture:** Introduce a single canonical source-space crop model in `AvatarCropDialog` based on `x / y / size`, plus a shared minimum size constant. Normalize every crop candidate through the same square-and-clamp logic, use that canonical state for export, and lock the behavior with focused dialog tests.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, react-easy-crop

---

## File Map

- Modify: `packages/web/src/components/profile/AvatarCropDialog.tsx` - add minimum size constant, canonical crop normalization, undersized-image rejection, slider bounds, export from canonical state
- Modify: `packages/web/test/components/profile/AvatarCropDialog.test.tsx` - add TDD coverage for size threshold, initial centered max square, slider bounds, invariant preservation, center-preserving resize, and recovery flow

## Test Helpers To Use

Use the existing test helpers/selectors in `packages/web/test/components/profile/AvatarCropDialog.test.tsx` instead of placeholders:

- `const slider = screen.getByRole("slider", { name: "settings.avatarCropZoom" }) as HTMLInputElement`
- `const confirmButton = screen.getByRole("button", { name: "common.confirm" })`
- `emitCropComplete(...)`
- `emitCropChange(...)`
- `loadPreview({ width, height })`
- `latestCropperProps`
- prefer verifying canonical behavior through exported pure helpers (`normalizeCropCandidate`, `resizeCanonicalCropFromCenter`, `toExportPixels`, `deriveCropperStateFromCanonicalCrop`) or `exportCroppedAvatar` payload assertions after confirm. These helpers must be exported from `packages/web/src/components/profile/AvatarCropDialog.tsx` or moved to a tiny dedicated helper module used by both component and tests

- `const file = new File(["avatar"], "avatar.png", { type: "image/png" })`
- `const smallFile = new File(["small"], "small.png", { type: "image/png" })`
- `const validFile = new File(["valid"], "valid.png", { type: "image/png" })`

## Chunk 1: Crop Constraints

### Task 1: Add the minimum-size gate and canonical crop normalization

**Files:**

- Modify: `packages/web/test/components/profile/AvatarCropDialog.test.tsx`
- Modify: `packages/web/src/components/profile/AvatarCropDialog.tsx`

- [ ] **Step 1: Write the failing tests**

```ts
it("rejects images whose short edge is smaller than AVATAR_MIN_CROP_SIZE", async () => {
  renderWithProviders(<AvatarCropDialog open file={smallFile} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  loadPreview({ width: 99, height: 140 });

  expect(await screen.findByRole("alert")).toHaveTextContent("100 x 100");
  expect(screen.getByRole("button", { name: "common.confirm" })).toBeDisabled();
});
```

```ts
it("initializes to the centered maximum legal square and slider range", () => {
  renderWithProviders(<AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  loadPreview({ width: 320, height: 220 });

  const slider = screen.getByRole("slider", { name: "settings.avatarCropZoom" }) as HTMLInputElement;
  const confirmButton = screen.getByRole("button", { name: "common.confirm" });
  emitCropComplete({ x: 50, y: 0, width: 220, height: 220 });

  expect(slider.min).toBe("100");
  expect(slider.max).toBe("220");
  expect(latestCropperProps?.cropSize).toEqual({ width: 192, height: 192 });
  expect(confirmButton).toBeEnabled();
});
```

```ts
it("accepts 100x100 images and locks slider min/max to 100", () => {
  renderWithProviders(<AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  loadPreview({ width: 100, height: 100 });

  const slider = screen.getByRole("slider", { name: "settings.avatarCropZoom" }) as HTMLInputElement;
  const confirmButton = screen.getByRole("button", { name: "common.confirm" });
  expect(slider.min).toBe("100");
  expect(slider.max).toBe("100");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  emitCropComplete({ x: 30, y: 0, width: 100, height: 100 });
  expect(confirmButton).toBeEnabled();
  emitCropComplete({ x: 0, y: 30, width: 100, height: 100 });
  expect(screen.getByRole("button", { name: "common.confirm" })).toBeEnabled();
  emitCropComplete({ x: 0, y: 0, width: 100, height: 100 });
  expect(screen.getByRole("button", { name: "common.confirm" })).toBeEnabled();
});
```

```ts
it("accepts 100xN images and locks slider min/max to 100", () => {
  renderWithProviders(<AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  loadPreview({ width: 100, height: 160 });

  expect(slider.min).toBe("100");
  expect(slider.max).toBe("100");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
```

```ts
it("accepts Nx100 images and locks slider min/max to 100", () => {
  renderWithProviders(<AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  loadPreview({ width: 160, height: 100 });

  expect(slider.min).toBe("100");
  expect(slider.max).toBe("100");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm exec vitest run packages/web/test/components/profile/AvatarCropDialog.test.tsx`
Expected: FAIL because the dialog currently allows undersized images, still derives behavior from cropper callbacks, and does not initialize from a canonical centered max square.

- [ ] **Step 3: Write minimal implementation**

Slider-driven resize must always clamp requested `size` to `[AVATAR_MIN_CROP_SIZE, shortEdge]` before it reaches canonical state.

```ts
const AVATAR_MIN_CROP_SIZE = 100;

type CanonicalCrop = {
  x: number;
  y: number;
  size: number;
};
```

```ts
function normalizeCropCandidate(input: {
  candidateX: number;
  candidateY: number;
  candidateWidth: number;
  candidateHeight: number;
  imageWidth: number;
  imageHeight: number;
}): CanonicalCrop {
  const shortEdge = Math.min(input.imageWidth, input.imageHeight);
  const size = clamp(
    Math.min(input.candidateWidth, input.candidateHeight),
    AVATAR_MIN_CROP_SIZE,
    shortEdge,
  );
  const x = clamp(input.candidateX + (input.candidateWidth - size) / 2, 0, input.imageWidth - size);
  const y = clamp(
    input.candidateY + (input.candidateHeight - size) / 2,
    0,
    input.imageHeight - size,
  );
  return { x, y, size };
}
```

```ts
function toExportPixels(crop: CanonicalCrop, imageWidth: number, imageHeight: number) {
  const size = Math.floor(crop.size);
  const x = clamp(Math.round(crop.x), 0, imageWidth - size);
  const y = clamp(Math.round(crop.y), 0, imageHeight - size);
  return { x, y, width: size, height: size };
}
```

```ts
setErrorMessage(null);
setCanonicalCrop(null);
setCropReady(false);
const shortEdge = Math.min(imageWidth, imageHeight);
if (shortEdge < AVATAR_MIN_CROP_SIZE) {
  setErrorMessage(
    `图片尺寸过小，头像至少需要 ${AVATAR_MIN_CROP_SIZE} x ${AVATAR_MIN_CROP_SIZE} 像素`,
  );
  return;
}

const initialSize = shortEdge;
setCanonicalCrop({
  x: Math.round((imageWidth - initialSize) / 2),
  y: Math.round((imageHeight - initialSize) / 2),
  size: initialSize,
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm exec vitest run packages/web/test/components/profile/AvatarCropDialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/profile/AvatarCropDialog.tsx packages/web/test/components/profile/AvatarCropDialog.test.tsx
git commit -m "fix(web): enforce avatar crop size constraints"  # requested by user in this session
```

## Chunk 2: Interaction Invariants

### Task 2: Keep drag, resize, export, and recovery aligned with canonical state

**Files:**

- Modify: `packages/web/test/components/profile/AvatarCropDialog.test.tsx`
- Modify: `packages/web/src/components/profile/AvatarCropDialog.tsx`

- [ ] **Step 1: Write the failing tests**

```ts
it("keeps full crop invariants for all four edges and four corners", () => {
  renderWithProviders(<AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  loadPreview({ width: 320, height: 220 });

  for (const area of [
    { x: 40, y: -30, width: 180, height: 180 },
    { x: 40, y: 80, width: 180, height: 180 },
    { x: -30, y: 20, width: 180, height: 180 },
    { x: 190, y: 20, width: 180, height: 180 },
    { x: -30, y: -20, width: 220, height: 220 },
    { x: 180, y: -20, width: 220, height: 220 },
    { x: -30, y: 40, width: 220, height: 220 },
    { x: 180, y: 40, width: 220, height: 220 },
  ]) {
    emitCropComplete(area);
    const crop = normalizeCropCandidate({ candidateX: area.x, candidateY: area.y, candidateWidth: area.width, candidateHeight: area.height, imageWidth: 320, imageHeight: 220 });
    expect(crop.x).toBeGreaterThanOrEqual(0);
    expect(crop.y).toBeGreaterThanOrEqual(0);
    expect(crop.x + crop.size).toBeLessThanOrEqual(320);
    expect(crop.y + crop.size).toBeLessThanOrEqual(220);
  }
});
```

```ts
it("keeps full crop invariants when resizing down to min and back up to max", async () => {
  renderWithProviders(<AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  loadPreview({ width: 320, height: 220 });
  emitCropComplete({ x: 50, y: 0, width: 220, height: 220 });

  const slider = screen.getByRole("slider", { name: "settings.avatarCropZoom" }) as HTMLInputElement;
  fireEvent.change(slider, { target: { value: "100" } });
  let crop = toExportPixels(normalizeCropCandidate({ candidateX: 110, candidateY: 60, candidateWidth: Number(slider.value), candidateHeight: Number(slider.value), imageWidth: 320, imageHeight: 220 }), 320, 220);
  expect(crop.width).toBeCloseTo(100, 5);
  expect(crop.height).toBeCloseTo(100, 5);
  expect(crop.x).toBeGreaterThanOrEqual(0);
  expect(crop.y).toBeGreaterThanOrEqual(0);
  expect(crop.x + crop.size).toBeLessThanOrEqual(320);
  expect(crop.y + crop.size).toBeLessThanOrEqual(220);

  fireEvent.change(slider, { target: { value: "220" } });
  crop = latestCanonicalCrop();
  expect(crop.width).toBeCloseTo(220, 5);
  expect(crop.height).toBeCloseTo(220, 5);
  expect(crop.x).toBeGreaterThanOrEqual(0);
  expect(crop.y).toBeGreaterThanOrEqual(0);
  expect(crop.x + crop.size).toBeLessThanOrEqual(320);
  expect(crop.y + crop.size).toBeLessThanOrEqual(220);
});
```

```ts
it("preserves center when resizing legally and applies only minimum correction near boundaries", async () => {
  renderWithProviders(<AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  loadPreview({ width: 320, height: 220 });
  emitCropComplete({ x: 90, y: 40, width: 140, height: 140 });

  const before = latestCanonicalCrop();
  const beforeCenter = { x: before.x + before.size / 2, y: before.y + before.size / 2 };
  const slider = screen.getByRole("slider", { name: "settings.avatarCropZoom" }) as HTMLInputElement;

  fireEvent.change(slider, { target: { value: "100" } });
  let after = toExportPixels(normalizeCropCandidate({ candidateX: 200, candidateY: 30, candidateWidth: 220, candidateHeight: 220, imageWidth: 320, imageHeight: 220 }), 320, 220);
  expect(after.x + after.size / 2).toBeCloseTo(beforeCenter.x, 5);
  expect(after.y + after.size / 2).toBeCloseTo(beforeCenter.y, 5);

  emitCropComplete({ x: 200, y: 30, width: 100, height: 100 });
  fireEvent.change(slider, { target: { value: "220" } });
  after = toExportPixels(normalizeCropCandidate({ candidateX: 200, candidateY: 30, candidateWidth: 220, candidateHeight: 220, imageWidth: 320, imageHeight: 220 }), 320, 220);
  expect(after.x).toBe(100);
  expect(after.y).toBe(0);
  expect(after.width).toBe(220);
  expect(after.height).toBe(220);
});
```

```ts
it("applies the shared export rounding rule after canonical crop selection", async () => {
  const user = userEvent.setup();
  vi.spyOn(avatarEditor, "exportCroppedAvatar").mockResolvedValue(new Blob(["webp"], { type: "image/webp" }));
  renderWithProviders(<AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  loadPreview({ width: 320, height: 220 });
  emitCropComplete({ x: 7.3, y: 12.4, width: 180.9, height: 220.2 });

  await user.click(screen.getByRole("button", { name: "common.confirm" }));
  expect(avatarEditor.exportCroppedAvatar).toHaveBeenCalledWith(
    expect.objectContaining({ cropAreaPixels: { x: 7, y: 32, width: 180, height: 180 } }),
  );
});
```

```ts
it("derives cropper display state from canonical crop after drag and slider updates", async () => {
  renderWithProviders(<AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  loadPreview({ width: 320, height: 220 });
  emitCropComplete({ x: 50, y: 0, width: 220, height: 220 });
  expect(latestCropperProps?.zoom).toBeDefined();

  emitCropChange({ x: 10, y: 12 });
  emitCropComplete({ x: 10, y: 12, width: 180, height: 180 });
  expect(latestCropperProps?.crop).toEqual(expect.any(Object));

  fireEvent.change(screen.getByRole("slider", { name: "settings.avatarCropZoom" }), { target: { value: "140" } });
  expect(latestCropperProps?.zoom).toBeDefined();
});
```

```ts
it("clears an undersized-image error after reloading a valid image in the same dialog", () => {
  const { rerender } = renderWithProviders(<AvatarCropDialog open file={smallFile} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  loadPreview({ width: 99, height: 140 });
  expect(screen.getByRole("alert")).toHaveTextContent("100 x 100");

  rerender(<AvatarCropDialog open file={validFile} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  loadPreview({ width: 320, height: 220 });
  emitCropComplete({ x: 50, y: 0, width: 220, height: 220 });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "common.confirm" })).toBeEnabled();
});
```

```ts
it("clears an undersized-image error after closing and reopening with a valid image", () => {
  const { rerender } = renderWithProviders(<AvatarCropDialog open file={smallFile} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  loadPreview({ width: 99, height: 140 });
  expect(screen.getByRole("alert")).toHaveTextContent("100 x 100");

  rerender(<AvatarCropDialog open={false} file={smallFile} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  rerender(<AvatarCropDialog open file={validFile} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  loadPreview({ width: 320, height: 220 });
  emitCropComplete({ x: 50, y: 0, width: 220, height: 220 });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "common.confirm" })).toBeEnabled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm exec vitest run packages/web/test/components/profile/AvatarCropDialog.test.tsx`
Expected: FAIL because drag/resize/export still rely on raw cropper callback values, slider resize is not clamped to `[100, shortEdge]`, and recovery behavior is not fully locked to the new canonical model.

- [ ] **Step 3: Write minimal implementation**

```ts
function resizeCanonicalCropFromCenter(
  crop: CanonicalCrop,
  nextSize: number,
  bounds: ImageBounds,
): CanonicalCrop {
  const centerX = crop.x + crop.size / 2;
  const centerY = crop.y + crop.size / 2;
  return normalizeCropCandidate({
    candidateX: centerX - nextSize / 2,
    candidateY: centerY - nextSize / 2,
    candidateWidth: nextSize,
    candidateHeight: nextSize,
    imageWidth: bounds.width,
    imageHeight: bounds.height,
  });
}
```

```ts
onCropComplete={(_, croppedAreaPixels) => {
  const nextCrop = normalizeCropCandidate({
    candidateX: croppedAreaPixels.x,
    candidateY: croppedAreaPixels.y,
    candidateWidth: croppedAreaPixels.width,
    candidateHeight: croppedAreaPixels.height,
    imageWidth,
    imageHeight,
  });
  setCanonicalCrop(nextCrop);
}}
```

```ts
const exportPixels = toExportPixels(canonicalCrop, imageWidth, imageHeight);
await exportCroppedAvatar({
  image: exportSource,
  cropAreaPixels: exportPixels,
  size: 512,
  maxBytes: MAX_UPLOAD_BYTES,
});
```

```ts
const cropperState = deriveCropperStateFromCanonicalCrop(canonicalCrop, imageWidth, imageHeight);
<Cropper crop={cropperState.crop} zoom={cropperState.zoom} cropSize={cropperState.cropSize} ... />
```

```ts
// deriveCropperStateFromCanonicalCrop is a pure helper; do not store a second mutable cropper state
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm exec vitest run packages/web/test/components/profile/AvatarCropDialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/profile/AvatarCropDialog.tsx packages/web/test/components/profile/AvatarCropDialog.test.tsx
git commit -m "fix(web): keep avatar crop state canonical"  # requested by user in this session
```

## Chunk 3: Verification

### Task 3: Re-verify the avatar crop flow

**Files:**

- Modify: `packages/web/test/components/profile/AvatarCropDialog.test.tsx`
- Modify: `packages/web/src/components/profile/AvatarCropDialog.tsx`

- [ ] **Step 1: Run targeted crop tests**

Run: `npm exec vitest run packages/web/test/components/profile/AvatarCropDialog.test.tsx`
Expected: PASS.

- [ ] **Step 2: Run the broader avatar verification suite**

Run: `npm exec vitest run packages/web/test/lib/avatar-editor.test.ts packages/web/test/components/profile/AvatarCropDialog.test.tsx test/signing-parity.test.ts`
Expected: PASS.

- [ ] **Step 3: Run web build**

Run: `npm run build --workspace @remi/web`
Expected: PASS.

- [ ] **Step 4: Run avatar crop e2e**

Run: `npm run test:e2e -- e2e/avatar-crop.spec.ts`
Expected: PASS.

- [ ] **Step 5: If any verification command fails, add or adjust the smallest failing test, make the minimal code change, rerun the failed command, then rerun the full verification set**

```ts
// Keep scope limited to canonical crop normalization, validation messaging, display-state derivation, and test fixtures needed to restore green verification.
```

- [ ] **Step 6: Re-run the full verification set**

Run: `npm exec vitest run packages/web/test/lib/avatar-editor.test.ts packages/web/test/components/profile/AvatarCropDialog.test.tsx test/signing-parity.test.ts && npm run build --workspace @remi/web && npm run test:e2e -- e2e/avatar-crop.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/profile/AvatarCropDialog.tsx packages/web/test/components/profile/AvatarCropDialog.test.tsx
git commit -m "test(web): verify revised avatar crop constraints"  # requested by user in this session
```

## Derive Cropper State Math

`deriveCropperStateFromCanonicalCrop(canonicalCrop, imageWidth, imageHeight)` must be a pure helper.

Use this mapping contract:

- `cropSize = { width: 192, height: 192 }`
- `zoom = cropSize.width / canonicalCrop.size`
- image center in source space: `(imageWidth / 2, imageHeight / 2)`
- crop center in source space: `(canonicalCrop.x + canonicalCrop.size / 2, canonicalCrop.y + canonicalCrop.size / 2)`
- derive `crop.x` / `crop.y` so the cropper displays the canonical crop center under the fixed crop box center
- tests do not need to re-prove the exact geometry math, but must verify that drag/slider updates feed back into canonical state and the derived props are recomputed from canonical state on rerender
