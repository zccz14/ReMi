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

const CROP_SIZE = 256;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AvatarCropDialog", () => {
  it("shows selected file preview, drag surface, and confirm button", () => {
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });

    stubPreviewUrl();

    renderWithProviders(
      <AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("settings.avatarCropTitle")).toBeInTheDocument();
    expect(screen.getByText("settings.avatarCropDescription")).toBeInTheDocument();
    expect(screen.getByTestId("avatar-crop-surface")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "settings.avatarCropPreviewAlt" })).toHaveAttribute(
      "src",
      "blob:avatar-preview",
    );
    expect(screen.getByRole("slider", { name: "settings.avatarCropZoom" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "common.confirm" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "common.cancel" })).toBeInTheDocument();
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

  it("keeps dragged preview coordinates consistent with exported crop for a wide image", async () => {
    const user = userEvent.setup();
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    const exportedBlob = new Blob(["webp"], { type: "image/webp" });
    const onConfirm = vi.fn();
    const exportSpy = vi.spyOn(avatarEditor, "exportCroppedAvatar").mockResolvedValue(exportedBlob);

    stubPreviewUrl();

    renderWithProviders(
      <AvatarCropDialog open file={file} onConfirm={onConfirm} onCancel={vi.fn()} />,
    );

    const preview = loadPreview({ width: 800, height: 400 });
    const surface = screen.getByTestId("avatar-crop-surface");
    installPointerCaptureStub(surface);
    const zoom = screen.getByRole("slider", { name: "settings.avatarCropZoom" });

    fireEvent.change(zoom, { target: { value: "1.5" } });
    fireEvent.pointerDown(surface, { pointerId: 1, buttons: 1, clientX: 100, clientY: 120 });
    fireEvent.pointerMove(surface, { pointerId: 1, buttons: 1, clientX: 220, clientY: 80 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 220, clientY: 80 });

    await user.click(screen.getByRole("button", { name: "common.confirm" }));

    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));

    const exportInput = exportSpy.mock.calls[0]?.[0];
    expect(exportInput).toEqual(
      expect.objectContaining({
        crop: { x: 120, y: -40 },
        zoom: 1.5,
        cropSize: CROP_SIZE,
        size: 512,
        maxBytes: 2 * 1024 * 1024,
        image: preview,
      }),
    );

    const expectedLeft = (CROP_SIZE - 800 * exportInput.zoom) / 2 + exportInput.crop.x;
    const expectedTop = (CROP_SIZE - 400 * exportInput.zoom) / 2 + exportInput.crop.y;

    expect(preview.style.left).toBe(`${expectedLeft}px`);
    expect(preview.style.top).toBe(`${expectedTop}px`);
    expect(onConfirm).toHaveBeenCalledWith(exportedBlob);
  });

  it("accumulates rapid drag deltas from the latest applied crop state", async () => {
    const user = userEvent.setup();
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    const exportSpy = vi
      .spyOn(avatarEditor, "exportCroppedAvatar")
      .mockResolvedValue(new Blob(["webp"], { type: "image/webp" }));

    stubPreviewUrl();

    renderWithProviders(
      <AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    loadPreview({ width: 800, height: 400 });
    const surface = screen.getByTestId("avatar-crop-surface");
    installPointerCaptureStub(surface);

    fireEvent.pointerDown(surface, { pointerId: 1, buttons: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(surface, { pointerId: 1, buttons: 1, clientX: 130, clientY: 90 });
    fireEvent.pointerMove(surface, { pointerId: 1, buttons: 1, clientX: 160, clientY: 80 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 160, clientY: 80 });

    await user.click(screen.getByRole("button", { name: "common.confirm" }));

    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));

    expect(exportSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        crop: { x: 60, y: -20 },
      }),
    );
  });

  it("clamps zoom and drag so a tall image never exposes empty space", async () => {
    const user = userEvent.setup();
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    const exportSpy = vi
      .spyOn(avatarEditor, "exportCroppedAvatar")
      .mockResolvedValue(new Blob(["webp"], { type: "image/webp" }));

    stubPreviewUrl();

    renderWithProviders(
      <AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    const preview = loadPreview({ width: 220, height: 320 });
    const surface = screen.getByTestId("avatar-crop-surface");
    installPointerCaptureStub(surface);
    const zoom = screen.getByRole("slider", {
      name: "settings.avatarCropZoom",
    }) as HTMLInputElement;

    fireEvent.change(zoom, { target: { value: "1" } });
    fireEvent.pointerDown(surface, { pointerId: 1, buttons: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(surface, { pointerId: 1, buttons: 1, clientX: 210, clientY: 310 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 210, clientY: 310 });

    await user.click(screen.getByRole("button", { name: "common.confirm" }));

    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));

    const exportInput = exportSpy.mock.calls[0]?.[0];
    const minZoom = CROP_SIZE / 220;
    const maxOffsetY = (320 * minZoom - CROP_SIZE) / 2;

    expect(exportInput.zoom).toBeCloseTo(minZoom, 5);
    expect(Number(zoom.value)).toBeCloseTo(minZoom, 5);
    expect(exportInput.crop.x).toBe(0);
    expect(exportInput.crop.y).toBeCloseTo(maxOffsetY, 5);
    expect(preview.style.left).toBe("0px");
    expect(preview.style.top).toBe("0px");
  });

  it("allows small images to zoom past 3x so preview and export still fully cover the crop", async () => {
    const user = userEvent.setup();
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    const exportSpy = vi
      .spyOn(avatarEditor, "exportCroppedAvatar")
      .mockResolvedValue(new Blob(["webp"], { type: "image/webp" }));

    stubPreviewUrl();

    renderWithProviders(
      <AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    const preview = loadPreview({ width: 40, height: 40 });
    const zoom = screen.getByRole("slider", {
      name: "settings.avatarCropZoom",
    }) as HTMLInputElement;

    expect(Number(zoom.min)).toBeCloseTo(6.4, 5);
    expect(Number(zoom.max)).toBeCloseTo(6.4, 5);
    expect(Number(zoom.value)).toBeCloseTo(6.4, 5);

    await user.click(screen.getByRole("button", { name: "common.confirm" }));

    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));

    const exportInput = exportSpy.mock.calls[0]?.[0];
    expect(exportInput.zoom).toBeCloseTo(6.4, 5);
    expect(preview.style.left).toBe("0px");
    expect(preview.style.top).toBe("0px");
  });

  it("keeps preview and export math coherent when rendered crop size is not 256px", async () => {
    const user = userEvent.setup();
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    const exportSpy = vi
      .spyOn(avatarEditor, "exportCroppedAvatar")
      .mockResolvedValue(new Blob(["webp"], { type: "image/webp" }));

    stubPreviewUrl();

    renderWithProviders(
      <AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    const surface = screen.getByTestId("avatar-crop-surface");
    installPointerCaptureStub(surface);
    installSurfaceRectStub(surface, 320);
    const preview = loadPreview({ width: 800, height: 400 });
    const zoom = screen.getByRole("slider", { name: "settings.avatarCropZoom" });

    fireEvent.change(zoom, { target: { value: "1.5" } });
    fireEvent.pointerDown(surface, { pointerId: 1, buttons: 1, clientX: 100, clientY: 120 });
    fireEvent.pointerMove(surface, { pointerId: 1, buttons: 1, clientX: 180, clientY: 80 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 180, clientY: 80 });

    await user.click(screen.getByRole("button", { name: "common.confirm" }));

    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));

    const exportInput = exportSpy.mock.calls[0]?.[0];
    expect(exportInput.crop.x).toBeCloseTo(64, 5);
    expect(exportInput.crop.y).toBeCloseTo(-32, 5);
    expect(preview.style.left).toBe("-510px");
    expect(preview.style.top).toBe("-255px");
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

    const surface = screen.getByTestId("avatar-crop-surface");
    installPointerCaptureStub(surface);
    loadPreview({ width: 800, height: 400 });

    await user.click(screen.getByRole("button", { name: "common.confirm" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("settings.avatarCropExportError");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("stops dragging after pointer capture is lost", async () => {
    const user = userEvent.setup();
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    const exportSpy = vi
      .spyOn(avatarEditor, "exportCroppedAvatar")
      .mockResolvedValue(new Blob(["webp"], { type: "image/webp" }));

    stubPreviewUrl();

    renderWithProviders(
      <AvatarCropDialog open file={file} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    loadPreview({ width: 800, height: 400 });
    const surface = screen.getByTestId("avatar-crop-surface");
    installPointerCaptureStub(surface);

    fireEvent.pointerDown(surface, { pointerId: 1, buttons: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(surface, { pointerId: 1, buttons: 1, clientX: 140, clientY: 100 });
    fireEvent.lostPointerCapture(surface, { pointerId: 1 });
    fireEvent.pointerMove(surface, { pointerId: 1, buttons: 1, clientX: 240, clientY: 100 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 240, clientY: 100 });

    await user.click(screen.getByRole("button", { name: "common.confirm" }));

    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));

    expect(exportSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        crop: { x: 40, y: 0 },
      }),
    );
  });
});

function stubPreviewUrl() {
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:avatar-preview"),
    revokeObjectURL: vi.fn(),
  });
}

function loadPreview({ width, height }: { width: number; height: number }) {
  const preview = screen.getByRole("img", { name: "settings.avatarCropPreviewAlt" });

  Object.defineProperty(preview, "naturalWidth", { configurable: true, value: width });
  Object.defineProperty(preview, "naturalHeight", { configurable: true, value: height });
  fireEvent.load(preview);

  return preview as HTMLImageElement;
}

function installPointerCaptureStub(element: HTMLElement) {
  let activePointerId: number | null = null;

  Object.defineProperties(element, {
    setPointerCapture: {
      configurable: true,
      value: (pointerId: number) => {
        activePointerId = pointerId;
      },
    },
    hasPointerCapture: {
      configurable: true,
      value: (pointerId: number) => activePointerId === pointerId,
    },
    releasePointerCapture: {
      configurable: true,
      value: (pointerId: number) => {
        if (activePointerId === pointerId) {
          activePointerId = null;
        }
      },
    },
  });
}

function installSurfaceRectStub(element: HTMLElement, size: number) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      width: size,
      height: size,
      top: 0,
      left: 0,
      right: size,
      bottom: size,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
}
