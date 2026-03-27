import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

interface PwaUpdateContextValue {
  hasUpdate: boolean;
  isApplying: boolean;
  applyUpdate: () => Promise<void>;
}

const PwaUpdateContext = createContext<PwaUpdateContextValue | null>(null);
const POLL_INTERVAL_MS = 5 * 60 * 1000;

export function usePwaUpdate(): PwaUpdateContextValue {
  const context = useContext(PwaUpdateContext);

  if (!context) {
    throw new Error("usePwaUpdate must be used within PwaUpdateProvider");
  }

  return context;
}

export function PwaUpdateProvider({ children }: { children: ReactNode }) {
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const checkForUpdate = useCallback(async () => {
    const registration = registrationRef.current;

    if (!registration) {
      return;
    }

    await registration.update();
  }, []);

  const { needRefresh } = useRegisterSW({
    onRegisteredSW: (_swUrl: string, registration?: ServiceWorkerRegistration) => {
      registrationRef.current = registration ?? null;
      void checkForUpdate();
    },
  });

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void checkForUpdate();
    }, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [checkForUpdate]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      void checkForUpdate();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [checkForUpdate]);

  const value = useMemo<PwaUpdateContextValue>(
    () => ({
      hasUpdate: needRefresh[0],
      isApplying: false,
      applyUpdate: async () => {},
    }),
    [needRefresh],
  );

  return <PwaUpdateContext.Provider value={value}>{children}</PwaUpdateContext.Provider>;
}
