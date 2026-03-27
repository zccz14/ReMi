import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "../helpers/test-utils";
import { PwaUpdateProvider, usePwaUpdate } from "../../src/hooks/use-pwa-update";

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

function TestConsumer() {
  const { hasUpdate } = usePwaUpdate();
  return <div data-testid="has-update">{String(hasUpdate)}</div>;
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
});
