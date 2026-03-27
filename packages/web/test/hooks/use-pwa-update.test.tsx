import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "../helpers/test-utils";
import { PwaUpdateProvider, usePwaUpdate } from "../../src/hooks/use-pwa-update";
import { toast } from "sonner";

const { useRegisterSWMock, registrationState } = vi.hoisted(() => ({
  useRegisterSWMock: vi.fn(),
  registrationState: {
    options: undefined as
      | {
          onRegisteredSW?: (swUrl: string, registration?: ServiceWorkerRegistration) => void;
        }
      | undefined,
  },
}));

vi.mock("virtual:pwa-register/react", () => ({
  useRegisterSW: useRegisterSWMock,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

const APPLY_TIMEOUT_MS = 10_000;
const STALE_UPDATE_MESSAGE = "This update is no longer available. Please try again.";
const UPDATE_TIMEOUT_MESSAGE = "Update timed out. Please try again.";

function TestConsumer() {
  const { hasUpdate, isApplying, applyUpdate } = usePwaUpdate();

  return (
    <>
      <div data-testid="has-update">{String(hasUpdate)}</div>
      <div data-testid="is-applying">{String(isApplying)}</div>
      <button type="button" onClick={() => void applyUpdate()}>
        apply update
      </button>
    </>
  );
}

function renderWithProvider() {
  return render(
    <PwaUpdateProvider>
      <TestConsumer />
    </PwaUpdateProvider>,
  );
}

function createRegistration() {
  return {
    update: vi.fn(async () => {}),
  } as unknown as ServiceWorkerRegistration;
}

function flushMicrotasks() {
  return Promise.resolve();
}

function setVisibilityState(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
}

beforeEach(() => {
  useRegisterSWMock.mockReset();
  registrationState.options = undefined;
  setVisibilityState("visible");
  vi.mocked(toast.error).mockClear();
  useRegisterSWMock.mockImplementation((options) => {
    registrationState.options = options;

    return {
      needRefresh: [false, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: vi.fn(),
    };
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("PwaUpdateProvider", () => {
  it("throws when usePwaUpdate is used outside the provider", () => {
    expect(() => render(<TestConsumer />)).toThrow(
      "usePwaUpdate must be used within PwaUpdateProvider",
    );
  });

  it.each([
    { needRefresh: false, expected: "false" },
    { needRefresh: true, expected: "true" },
  ])("maps needRefresh=$needRefresh to hasUpdate=$expected", ({ needRefresh, expected }) => {
    useRegisterSWMock.mockReturnValue({
      needRefresh: [needRefresh, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: vi.fn(),
    });

    const { getByTestId } = renderWithProvider();

    expect(getByTestId("has-update")).toHaveTextContent(expected);
  });

  it("no-ops when registration is not ready", () => {
    vi.useFakeTimers();
    const registration = createRegistration();

    renderWithProvider();

    expect(() => {
      act(() => {
        registrationState.options?.onRegisteredSW?.("/sw.js", undefined);
      });
    }).not.toThrow();

    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000);
    });

    expect(registrationState.options?.onRegisteredSW).toEqual(expect.any(Function));
    expect(registration.update).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("runs an initial background update check", async () => {
    const registration = createRegistration();

    renderWithProvider();

    act(() => {
      registrationState.options?.onRegisteredSW?.("/sw.js", registration);
    });

    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  it("swallows background update check failures", async () => {
    const registration = {
      update: vi.fn().mockRejectedValue(new Error("update failed")),
    } as unknown as ServiceWorkerRegistration;

    renderWithProvider();

    expect(() => {
      act(() => {
        registrationState.options?.onRegisteredSW?.("/sw.js", registration);
      });
    }).not.toThrow();

    await expect(flushMicrotasks()).resolves.toBeUndefined();
    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  it("polls for updates every 5 minutes", () => {
    vi.useFakeTimers();
    const registration = createRegistration();

    renderWithProvider();

    act(() => {
      registrationState.options?.onRegisteredSW?.("/sw.js", registration);
    });

    expect(registration.update).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000);
    });

    expect(registration.update).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("re-checks on visible foreground transitions", () => {
    const registration = createRegistration();

    renderWithProvider();

    act(() => {
      registrationState.options?.onRegisteredSW?.("/sw.js", registration);
    });

    expect(registration.update).toHaveBeenCalledTimes(1);

    setVisibilityState("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(registration.update).toHaveBeenCalledTimes(1);

    setVisibilityState("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(registration.update).toHaveBeenCalledTimes(2);
  });

  it("stops interval and visibility checks after unmount", () => {
    vi.useFakeTimers();
    const registration = createRegistration();

    const view = renderWithProvider();

    act(() => {
      registrationState.options?.onRegisteredSW?.("/sw.js", registration);
    });

    expect(registration.update).toHaveBeenCalledTimes(1);

    view.unmount();

    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000);
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  it("applies an available update once", async () => {
    let resolveUpdate: (() => void) | undefined;
    const updateServiceWorker = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUpdate = resolve;
        }),
    );

    useRegisterSWMock.mockReturnValue({
      needRefresh: [true, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker,
    });

    const view = renderWithProvider();

    await act(async () => {
      view.getByRole("button", { name: "apply update" }).click();
      await flushMicrotasks();
    });

    expect(updateServiceWorker).toHaveBeenCalledTimes(1);
    expect(view.getByTestId("is-applying")).toHaveTextContent("true");

    await act(async () => {
      resolveUpdate?.();
      await flushMicrotasks();
    });

    expect(view.getByTestId("is-applying")).toHaveTextContent("false");
  });

  it("ignores repeated apply attempts while updating", async () => {
    let resolveUpdate: (() => void) | undefined;
    const updateServiceWorker = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUpdate = resolve;
        }),
    );

    useRegisterSWMock.mockReturnValue({
      needRefresh: [true, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker,
    });

    const view = renderWithProvider();

    await act(async () => {
      view.getByRole("button", { name: "apply update" }).click();
      await flushMicrotasks();
    });

    await act(async () => {
      view.getByRole("button", { name: "apply update" }).click();
      await flushMicrotasks();
    });

    expect(updateServiceWorker).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveUpdate?.();
      await flushMicrotasks();
    });
  });

  it("refuses to apply a stale update", async () => {
    const updateServiceWorker = vi.fn(async () => {});

    useRegisterSWMock.mockReturnValue({
      needRefresh: [false, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker,
    });

    const view = renderWithProvider();

    await act(async () => {
      view.getByRole("button", { name: "apply update" }).click();
      await flushMicrotasks();
    });

    expect(updateServiceWorker).not.toHaveBeenCalled();
    expect(view.getByTestId("is-applying")).toHaveTextContent("false");
    expect(toast.error).toHaveBeenCalledWith(STALE_UPDATE_MESSAGE);
  });

  it("times out a stuck update apply", async () => {
    vi.useFakeTimers();
    const updateServiceWorker = vi.fn(() => new Promise<void>(() => {}));

    useRegisterSWMock.mockReturnValue({
      needRefresh: [true, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker,
    });

    const view = renderWithProvider();

    await act(async () => {
      view.getByRole("button", { name: "apply update" }).click();
      await flushMicrotasks();
    });

    expect(view.getByTestId("is-applying")).toHaveTextContent("true");
    expect(toast.error).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(APPLY_TIMEOUT_MS);
      await flushMicrotasks();
    });

    expect(updateServiceWorker).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(UPDATE_TIMEOUT_MESSAGE);
    expect(view.getByTestId("is-applying")).toHaveTextContent("false");
  });

  it("clears the apply timeout after a successful update", async () => {
    vi.useFakeTimers();
    let resolveUpdate: (() => void) | undefined;
    const updateServiceWorker = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUpdate = resolve;
        }),
    );

    useRegisterSWMock.mockReturnValue({
      needRefresh: [true, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker,
    });

    const view = renderWithProvider();
    const baselineTimerCount = vi.getTimerCount();

    await act(async () => {
      view.getByRole("button", { name: "apply update" }).click();
      await flushMicrotasks();
    });

    await act(async () => {
      resolveUpdate?.();
      await flushMicrotasks();
    });

    expect(view.getByTestId("is-applying")).toHaveTextContent("false");
    expect(vi.getTimerCount()).toBe(baselineTimerCount);

    await act(async () => {
      vi.advanceTimersByTime(APPLY_TIMEOUT_MS);
      await flushMicrotasks();
    });

    expect(toast.error).not.toHaveBeenCalled();
  });
});
