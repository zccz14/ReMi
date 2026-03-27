import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "../helpers/test-utils";
import { PwaUpdateProvider, usePwaUpdate } from "../../src/hooks/use-pwa-update";

const { useRegisterSWMock } = vi.hoisted(() => ({
  useRegisterSWMock: vi.fn(),
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

beforeEach(() => {
  useRegisterSWMock.mockReset();
  useRegisterSWMock.mockReturnValue({
    needRefresh: [false, vi.fn()],
    offlineReady: [false, vi.fn()],
    updateServiceWorker: vi.fn(),
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
});
