import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanup,
  fireEvent,
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
} from "../../helpers/test-utils";
import {
  AVATAR_MIN_CROP_SIZE,
  AvatarCropDialog,
  deriveCropperStateFromCanonicalCrop,
  normalizeCropCandidate,
  resizeCanonicalCropFromCenter,
  toExportPixels,
} from "../../../src/components/profile/AvatarCropDialog";
import * as avatarEditor from "../../../src/lib/avatar-editor";

type CropperArea = { x: number; y: number; width: number; height: number };
type MockCropperProps = {
  image: string;
  crop: { x: number; y: number };
  zoom: number;
  minZoom?: number;
  maxZoom?: number;
  cropSize?: { width: number; height: number };
  objectFit?: string;
  onCropChange: (crop: { x: number; y: number }) => void;
  onZoomChange: (zoom: number) => void;
  onCropComplete?: (_: CropperArea, croppedAreaPixels: CropperArea) => void;
};

let latestCropperProps: MockCropperProps | null = null;
let pendingCropCompleteArea: CropperArea | null = null;

vi.mock("react-easy-crop", () => ({
  default: (props: MockCropperProps) => {
    latestCropperProps = props;

    return (
      <>
        <div
          data-testid="avatar-cropper"
          data-image={props.image}
          data-zoom={String(props.zoom)}
          data-min-zoom={String(props.minZoom ?? "")}
          data-max-zoom={String(props.maxZoom ?? "")}
          data-crop-width={String(props.cropSize?.width ?? "")}
          data-crop-height={String(props.cropSize?.height ?? "")}
          data-object-fit={props.objectFit ?? ""}
        />
        <button
          type="button"
          aria-label="emit crop complete"
          onClick={() => {
            if (!pendingCropCompleteArea) {
              throw new Error("No pending crop area configured");
            }

            props.onCropComplete?.(pendingCropCompleteArea, pendingCropCompleteArea);
          }}
        />
      </>
    );
  },
}));

afterEach(() => {
  cleanup();
  latestCropperProps = null;
  pendingCropCompleteArea = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AvatarCropDialog helpers", () => {
  it("extracts the minimum crop size into a shared constant", () => {
    expect(AVATAR_MIN_CROP_SIZE).toBe(100);
  });

  it("normalizes crop candidates into an in-bounds square", () => {
    for (const candidate of [
      { x: 40, y: -30, width: 180, height: 180 },
      { x: 40, y: 80, width: 180, height: 180 },
      { x: -30, y: 20, width: 180, height: 180 },
      { x: 190, y: 20, width: 180, height: 180 },
      { x: -30, y: -20, width: 220, height: 220 },
      { x: 180, y: -20, width: 220, height: 220 },
      { x: -30, y: 40, width: 220, height: 220 },
      { x: 180, y: 40, width: 220, height: 220 },
    ]) {
      const crop = normalizeCropCandidate({
        candidateX: candidate.x,
        candidateY: candidate.y,
        candidateWidth: candidate.width,
        candidateHeight: candidate.height,
        imageWidth: 320,
        imageHeight: 220,
      });

      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.size).toBeGreaterThanOrEqual(AVATAR_MIN_CROP_SIZE);
      expect(crop.x + crop.size).toBeLessThanOrEqual(320);
      expect(crop.y + crop.size).toBeLessThanOrEqual(220);
    }
  });

  it("preserves center when resizing legally and applies only minimum correction near boundaries", () => {
    const centeredCrop = { x: 90, y: 40, size: 140 };
    const shrunk = resizeCanonicalCropFromCenter(centeredCrop, 100, {
      width: 320,
      height: 220,
    });
    const centeredBefore = {
      x: centeredCrop.x + centeredCrop.size / 2,
      y: centeredCrop.y + centeredCrop.size / 2,
    };

    expect(shrunk.x + shrunk.size / 2).toBeCloseTo(centeredBefore.x, 5);
    expect(shrunk.y + shrunk.size / 2).toBeCloseTo(centeredBefore.y, 5);

    const boundaryCrop = { x: 200, y: 30, size: 100 };
    const expanded = resizeCanonicalCropFromCenter(boundaryCrop, 220, {
      width: 320,
      height: 220,
    });

    expect(expanded).toEqual({ x: 100, y: 0, size: 220 });
  });

  it("applies the shared export rounding rule", () => {
    expect(toExportPixels({ x: 7.3, y: 12.4, size: 180.9 }, 320, 220)).toEqual({
      x: 7,
      y: 12,
      width: 180,
      height: 180,
    });
  });

  it("derives cropper adapter state from canonical crop", () => {
    expect(
      deriveCropperStateFromCanonicalCrop({ x: 50, y: 0, size: 220 }, 320, 220),
    ).toEqual(
      expect.objectContaining({
        cropSize: { width: 192, height: 192 },
        zoom: 192 / 220,
      }),
    );
  });
});

describe("AvatarCropDialog", () => {
  it("rejects images whose short edge is smaller than the minimum crop size", async () => {
    const smallFile = new File(["small"], "small.png", { type: "image/png" });

    stubPreviewUrl();

    renderWithProviders(
      <AvatarCropDialog open file={smallFile} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    loadPreview({ width: 99, height: 140 });

    expect(await screen.findByRole("alert")).toHaveTextContent("100 x 100");
    expect(screen.getByRole("button", { name: "common.confirm" })).toBeDisabled();
  });

  it("initializes to the centered maximum legal square and slider range", () => {
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });

    stubPreviewUrl();

    renderWithProviders(
      <AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    loadPreview({ width: 320, height: 220 });

    const slider = screen.getByRole("slider", {
      name: "settings.avatarCropZoom",
    }) as HTMLInputElement;

    expect(slider.min).toBe(String(AVATAR_MIN_CROP_SIZE));
    expect(slider.max).toBe("220");
    expect(slider.value).toBe("220");
    expect(latestCropperProps?.cropSize).toEqual({ width: 192, height: 192 });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "common.confirm" })).toBeEnabled();
  });

  it("accepts boundary-valid images and locks slider min/max to 100 when short edge is 100", () => {
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });

    stubPreviewUrl();

    const { rerender } = renderWithProviders(
      <AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    loadPreview({ width: 100, height: 100 });
    let slider = screen.getByRole("slider", { name: "settings.avatarCropZoom" }) as HTMLInputElement;
    expect(slider.min).toBe("100");
    expect(slider.max).toBe("100");
    expect(slider.value).toBe("100");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "common.confirm" })).toBeEnabled();

    rerender(<AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    loadPreview({ width: 100, height: 160 });
    slider = screen.getByRole("slider", { name: "settings.avatarCropZoom" }) as HTMLInputElement;
    expect(slider.min).toBe("100");
    expect(slider.max).toBe("100");

    rerender(<AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    loadPreview({ width: 160, height: 100 });
    slider = screen.getByRole("slider", { name: "settings.avatarCropZoom" }) as HTMLInputElement;
    expect(slider.min).toBe("100");
    expect(slider.max).toBe("100");
  });

  it("normalizes library crop pixels before export", async () => {
    const user = userEvent.setup();
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    const exportedBlob = new Blob(["webp"], { type: "image/webp" });
    const exportSpy = vi.spyOn(avatarEditor, "exportCroppedAvatar").mockResolvedValue(exportedBlob);

    stubPreviewUrl();

    renderWithProviders(
      <AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    loadPreview({ width: 320, height: 220 });
    emitCropComplete({ x: 7.3, y: 12.4, width: 180.9, height: 220.2 });

    await user.click(screen.getByRole("button", { name: "common.confirm" }));

    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));
    expect(exportSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        cropAreaPixels: { x: 7, y: 32, width: 180, height: 180 },
      }),
    );
  });

  it("resizes from the current center and applies only minimal overflow correction", async () => {
    const user = userEvent.setup();
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    const exportedBlob = new Blob(["webp"], { type: "image/webp" });
    const exportSpy = vi.spyOn(avatarEditor, "exportCroppedAvatar").mockResolvedValue(exportedBlob);

    stubPreviewUrl();

    renderWithProviders(
      <AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    loadPreview({ width: 320, height: 220 });
    emitCropComplete({ x: 200, y: 30, width: 100, height: 100 });

    const slider = screen.getByRole("slider", {
      name: "settings.avatarCropZoom",
    }) as HTMLInputElement;

    fireEvent.change(slider, { target: { value: "220" } });
    await user.click(screen.getByRole("button", { name: "common.confirm" }));

    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));
    expect(exportSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        cropAreaPixels: { x: 100, y: 0, width: 220, height: 220 },
      }),
    );
  });

  it("clears an undersized-image error after reloading a valid image in the same dialog", async () => {
    const smallFile = new File(["small"], "small.png", { type: "image/png" });
    const validFile = new File(["valid"], "valid.png", { type: "image/png" });

    stubPreviewUrl();

    const { rerender } = renderWithProviders(
      <AvatarCropDialog open file={smallFile} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    loadPreview({ width: 99, height: 140 });
    expect(await screen.findByRole("alert")).toHaveTextContent("100 x 100");

    rerender(<AvatarCropDialog open file={validFile} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    loadPreview({ width: 320, height: 220 });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "common.confirm" })).toBeEnabled();
  });

  it("clears an undersized-image error after closing and reopening with a valid image", async () => {
    const smallFile = new File(["small"], "small.png", { type: "image/png" });
    const validFile = new File(["valid"], "valid.png", { type: "image/png" });

    stubPreviewUrl();

    const { rerender } = renderWithProviders(
      <AvatarCropDialog open file={smallFile} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    loadPreview({ width: 99, height: 140 });
    expect(await screen.findByRole("alert")).toHaveTextContent("100 x 100");

    rerender(<AvatarCropDialog open={false} file={smallFile} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    rerender(<AvatarCropDialog open file={validFile} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    loadPreview({ width: 320, height: 220 });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "common.confirm" })).toBeEnabled();
  });
});

function stubPreviewUrl() {
  const previewUrl = {
    createObjectURL: vi.fn(() => "blob:avatar-preview"),
    revokeObjectURL: vi.fn(),
  };

  vi.stubGlobal("URL", previewUrl);

  return previewUrl;
}

function loadPreview({ width, height }: { width: number; height: number }) {
  const preview = screen.getByTestId("avatar-export-source");

  Object.defineProperty(preview, "naturalWidth", { configurable: true, value: width });
  Object.defineProperty(preview, "naturalHeight", { configurable: true, value: height });
  fireEvent.load(preview);

  return preview as HTMLImageElement;
}

function emitCropComplete(area: CropperArea) {
  pendingCropCompleteArea = area;
  fireEvent.click(screen.getByRole("button", { name: "emit crop complete" }));
}
