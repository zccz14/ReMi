import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanup,
  fireEvent,
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
} from "../../helpers/test-utils";
import { AvatarCropDialog } from "../../../src/components/profile/AvatarCropDialog";
import * as avatarEditor from "../../../src/lib/avatar-editor";

type CropperArea = { x: number; y: number; width: number; height: number };
type MockCropperProps = {
  image: string;
  crop: { x: number; y: number };
  zoom: number;
  minZoom?: number;
  maxZoom?: number;
  objectFit?: string;
  onCropChange: (crop: { x: number; y: number }) => void;
  onZoomChange: (zoom: number) => void;
  onCropComplete?: (_: CropperArea, croppedAreaPixels: CropperArea) => void;
};

let latestCropperProps: MockCropperProps | null = null;
let pendingCropCompleteArea: CropperArea | null = null;
let loadedImageDimensions: { width: number; height: number } | null = null;

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
  loadedImageDimensions = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AvatarCropDialog", () => {
  it("shows selected file preview, cropper surface, slider, and disabled confirm before ready", () => {
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });

    stubPreviewUrl();

    renderWithProviders(
      <AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("settings.avatarCropTitle")).toBeInTheDocument();
    expect(screen.getByText("settings.avatarCropDescription")).toBeInTheDocument();
    expect(screen.getByTestId("avatar-crop-surface")).toBeInTheDocument();
    expect(screen.getByTestId("avatar-cropper")).toHaveAttribute(
      "data-image",
      "blob:avatar-preview",
    );
    expect(screen.getByText("avatar.png")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "settings.avatarCropZoom" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "common.confirm" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "common.cancel" })).toBeInTheDocument();
  });

  it("derives the min zoom baseline from the landscape image and only becomes ready after source load plus first crop result", () => {
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });

    stubPreviewUrl();

    renderWithProviders(
      <AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    const slider = screen.getByRole("slider", {
      name: "settings.avatarCropZoom",
    }) as HTMLInputElement;
    const confirmButton = screen.getByRole("button", { name: "common.confirm" });

    expect(slider.value).toBe("1");
    expect(confirmButton).toBeDisabled();

    loadPreview({ width: 320, height: 220 });

    const minZoomBaseline = 256 / 220;

    expect(Number(slider.min)).toBeCloseTo(minZoomBaseline, 5);
    expect(Number(slider.value)).toBeCloseTo(minZoomBaseline, 5);
    expect(latestCropperProps?.crop).toEqual({ x: 0, y: 0 });
    expect(latestCropperProps?.minZoom).toBeCloseTo(minZoomBaseline, 5);
    expect(latestCropperProps?.zoom).toBeCloseTo(minZoomBaseline, 5);
    expect(latestCropperProps?.objectFit).toBe("contain");
    expect(confirmButton).toBeDisabled();

    emitCropComplete({ x: 10, y: 20, width: 180, height: 180 });

    expect(screen.getByRole("button", { name: "common.confirm" })).toBeEnabled();
  });

  it("derives the min zoom baseline from the portrait image", () => {
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });

    stubPreviewUrl();

    renderWithProviders(
      <AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    const slider = screen.getByRole("slider", {
      name: "settings.avatarCropZoom",
    }) as HTMLInputElement;

    loadPreview({ width: 220, height: 320 });

    const minZoomBaseline = 256 / 220;

    expect(Number(slider.min)).toBeCloseTo(minZoomBaseline, 5);
    expect(Number(slider.value)).toBeCloseTo(minZoomBaseline, 5);
    expect(latestCropperProps?.crop).toEqual({ x: 0, y: 0 });
    expect(latestCropperProps?.minZoom).toBeCloseTo(minZoomBaseline, 5);
    expect(latestCropperProps?.zoom).toBeCloseTo(minZoomBaseline, 5);
    expect(latestCropperProps?.objectFit).toBe("contain");
  });

  it("changes zoom state from the slider and confirms using the latest cropper-derived croppedAreaPixels", async () => {
    const user = userEvent.setup();
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    const exportedBlob = new Blob(["webp"], { type: "image/webp" });
    const exportSpy = vi.spyOn(avatarEditor, "exportCroppedAvatar").mockResolvedValue(exportedBlob);
    const onConfirm = vi.fn();

    stubPreviewUrl();

    renderWithProviders(
      <AvatarCropDialog open file={file} onConfirm={onConfirm} onCancel={vi.fn()} />,
    );

    loadPreview({ width: 800, height: 400 });
    emitDerivedCropComplete();

    const slider = screen.getByRole("slider", {
      name: "settings.avatarCropZoom",
    }) as HTMLInputElement;
    const initialExportArea = getLatestDerivedCropArea();

    fireEvent.change(slider, { target: { value: "1.75" } });
    expect(latestCropperProps?.zoom).toBe(1.75);

    emitDerivedCropComplete();
    const zoomedExportArea = getLatestDerivedCropArea();

    expect(zoomedExportArea.width).toBeLessThan(initialExportArea.width);
    expect(zoomedExportArea.height).toBeLessThan(initialExportArea.height);

    emitCropChange({ x: 55, y: 66 });
    await waitFor(() => expect(latestCropperProps?.crop).toEqual({ x: 55, y: 66 }));

    emitDerivedCropComplete();
    const movedExportArea = getLatestDerivedCropArea();

    expect(movedExportArea.x).not.toBe(zoomedExportArea.x);
    expect(movedExportArea.y).not.toBe(zoomedExportArea.y);

    await user.click(screen.getByRole("button", { name: "common.confirm" }));

    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));
    expect(exportSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        cropAreaPixels: movedExportArea,
        size: 512,
        maxBytes: 2 * 1024 * 1024,
      }),
    );
    expect(onConfirm).toHaveBeenCalledWith(exportedBlob);
  });

  it("resets confirm readiness on dialog reopen and file change", () => {
    const firstFile = new File(["avatar"], "avatar.png", { type: "image/png" });
    const secondFile = new File(["avatar-2"], "avatar-2.png", { type: "image/png" });

    stubPreviewUrl();

    const { rerender } = renderWithProviders(
      <AvatarCropDialog open file={firstFile} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    loadPreview({ width: 800, height: 400 });
    emitCropComplete({ x: 10, y: 20, width: 180, height: 180 });
    expect(screen.getByRole("button", { name: "common.confirm" })).toBeEnabled();

    rerender(
      <AvatarCropDialog open={false} file={firstFile} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    rerender(<AvatarCropDialog open file={firstFile} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByRole("button", { name: "common.confirm" })).toBeDisabled();

    loadPreview({ width: 800, height: 400 });
    emitCropComplete({ x: 11, y: 22, width: 170, height: 170 });
    expect(screen.getByRole("button", { name: "common.confirm" })).toBeEnabled();

    rerender(<AvatarCropDialog open file={secondFile} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("button", { name: "common.confirm" })).toBeDisabled();
  });

  it("keeps confirm locked while async parent submit is still running", async () => {
    const user = userEvent.setup();
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    const exportedBlob = new Blob(["webp"], { type: "image/webp" });
    const exportSpy = vi.spyOn(avatarEditor, "exportCroppedAvatar").mockResolvedValue(exportedBlob);
    let resolveConfirm: (() => void) | undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        }),
    );

    stubPreviewUrl();

    renderWithProviders(
      <AvatarCropDialog open file={file} onConfirm={onConfirm} onCancel={vi.fn()} />,
    );

    loadPreview({ width: 800, height: 400 });
    emitCropComplete({ x: 10, y: 20, width: 180, height: 180 });

    const confirmButton = screen.getByRole("button", { name: "common.confirm" });
    const cancelButton = screen.getByRole("button", { name: "common.cancel" });

    await user.click(confirmButton);

    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(confirmButton).toBeDisabled();
    expect(cancelButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "settings.avatarCropSubmitting" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "settings.avatarCropSubmitting" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    expect(resolveConfirm).toBeDefined();
    resolveConfirm!();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "common.confirm" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "common.cancel" })).toBeEnabled();
    });
  });

  it("does not close from overlay or escape while async submit is running", async () => {
    const user = userEvent.setup();
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    const exportedBlob = new Blob(["webp"], { type: "image/webp" });
    const onCancel = vi.fn();
    let resolveConfirm: (() => void) | undefined;

    vi.spyOn(avatarEditor, "exportCroppedAvatar").mockResolvedValue(exportedBlob);
    stubPreviewUrl();

    renderWithProviders(
      <AvatarCropDialog
        open
        file={file}
        onConfirm={() =>
          new Promise<void>((resolve) => {
            resolveConfirm = resolve;
          })
        }
        onCancel={onCancel}
      />,
    );

    loadPreview({ width: 800, height: 400 });
    emitCropComplete({ x: 10, y: 20, width: 180, height: 180 });

    await user.click(screen.getByRole("button", { name: "common.confirm" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "settings.avatarCropSubmitting" })).toBeDisabled();
    });

    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay).not.toBeNull();
    if (overlay) {
      fireEvent.click(overlay);
    }
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onCancel).not.toHaveBeenCalled();

    expect(resolveConfirm).toBeDefined();
    resolveConfirm!();
  });

  it("shows a user-visible error when avatar export fails", async () => {
    const user = userEvent.setup();
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    const onConfirm = vi.fn();

    vi.spyOn(avatarEditor, "exportCroppedAvatar").mockRejectedValue(new Error("export failed"));

    stubPreviewUrl();

    renderWithProviders(
      <AvatarCropDialog open file={file} onConfirm={onConfirm} onCancel={vi.fn()} />,
    );

    loadPreview({ width: 800, height: 400 });
    emitCropComplete({ x: 10, y: 20, width: 180, height: 180 });

    await user.click(screen.getByRole("button", { name: "common.confirm" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("settings.avatarCropExportError");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does not show the export error when parent submit rejects after export succeeds", async () => {
    const user = userEvent.setup();
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    const exportedBlob = new Blob(["webp"], { type: "image/webp" });
    const submitError = new Error("submit failed");
    const onConfirm = vi.fn().mockRejectedValue(submitError);

    vi.spyOn(avatarEditor, "exportCroppedAvatar").mockResolvedValue(exportedBlob);

    stubPreviewUrl();

    renderWithProviders(
      <AvatarCropDialog open file={file} onConfirm={onConfirm} onCancel={vi.fn()} />,
    );

    loadPreview({ width: 800, height: 400 });
    emitCropComplete({ x: 10, y: 20, width: 180, height: 180 });

    await user.click(screen.getByRole("button", { name: "common.confirm" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(exportedBlob));
    expect(screen.queryByText("settings.avatarCropExportError")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

function stubPreviewUrl() {
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:avatar-preview"),
    revokeObjectURL: vi.fn(),
  });
}

function loadPreview({ width, height }: { width: number; height: number }) {
  const preview = screen.getByTestId("avatar-export-source");

  Object.defineProperty(preview, "naturalWidth", { configurable: true, value: width });
  Object.defineProperty(preview, "naturalHeight", { configurable: true, value: height });
  loadedImageDimensions = { width, height };
  fireEvent.load(preview);

  return preview as HTMLImageElement;
}

function emitCropComplete(area: CropperArea) {
  pendingCropCompleteArea = area;
  fireEvent.click(screen.getByRole("button", { name: "emit crop complete" }));
}

function emitCropChange(crop: { x: number; y: number }) {
  latestCropperProps?.onCropChange(crop);
}

function emitDerivedCropComplete() {
  emitCropComplete(getLatestDerivedCropArea());
}

function getLatestDerivedCropArea(): CropperArea {
  if (!latestCropperProps || !loadedImageDimensions) {
    throw new Error("Cropper props or loaded image dimensions are unavailable");
  }

  const viewportSize = 256;
  const minDimension = Math.min(loadedImageDimensions.width, loadedImageDimensions.height);
  const visibleSize = Math.min(minDimension, viewportSize / latestCropperProps.zoom);
  const maxX = loadedImageDimensions.width - visibleSize;
  const maxY = loadedImageDimensions.height - visibleSize;
  const centeredX = maxX / 2;
  const centeredY = maxY / 2;

  return {
    x: clamp(Math.round(centeredX + latestCropperProps.crop.x), 0, Math.round(maxX)),
    y: clamp(Math.round(centeredY + latestCropperProps.crop.y), 0, Math.round(maxY)),
    width: Math.round(visibleSize),
    height: Math.round(visibleSize),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
