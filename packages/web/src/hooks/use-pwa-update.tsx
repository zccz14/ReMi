import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { useRegisterSW } from "virtual:pwa-register/react";

interface PwaUpdateContextValue {
  hasUpdate: boolean;
  isApplying: boolean;
  applyUpdate: () => Promise<void>;
}

const PwaUpdateContext = createContext<PwaUpdateContextValue | null>(null);
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const APPLY_TIMEOUT_MS = 10_000;
const STALE_UPDATE_MESSAGE = "This update is no longer available. Please try again.";
const UPDATE_FAILED_MESSAGE = "Update failed. Please try again.";
const UPDATE_TIMEOUT_MESSAGE = "Update timed out. Please try again.";

export function usePwaUpdate(): PwaUpdateContextValue {
  const context = useContext(PwaUpdateContext);

  if (!context) {
    throw new Error("usePwaUpdate must be used within PwaUpdateProvider");
  }

  return context;
}

export function PwaUpdateProvider({ children }: { children: ReactNode }) {
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const isApplyingRef = useRef(false);
  const [isApplying, setIsApplying] = useState(false);
  const checkForUpdate = useCallback(async () => {
    const registration = registrationRef.current;

    if (!registration) {
      return;
    }

    await registration.update();
  }, []);
  const runBackgroundUpdateCheck = useCallback(() => {
    void checkForUpdate().catch(() => {});
  }, [checkForUpdate]);

  const { needRefresh, updateServiceWorker } = useRegisterSW({
    onRegisteredSW: (_swUrl: string, registration?: ServiceWorkerRegistration) => {
      registrationRef.current = registration ?? null;
      runBackgroundUpdateCheck();
    },
  });

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      runBackgroundUpdateCheck();
    }, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [runBackgroundUpdateCheck]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      runBackgroundUpdateCheck();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [runBackgroundUpdateCheck]);

  const applyUpdate = useCallback(async () => {
    if (isApplyingRef.current) {
      return;
    }

    if (!needRefresh[0]) {
      toast.error(STALE_UPDATE_MESSAGE);
      return;
    }

    isApplyingRef.current = true;
    setIsApplying(true);
    let timeoutId: number | undefined;

    try {
      await Promise.race([
        updateServiceWorker(),
        new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(() => {
            reject(new Error("PWA apply update timed out"));
          }, APPLY_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      toast.error(
        error instanceof Error && error.message === "PWA apply update timed out"
          ? UPDATE_TIMEOUT_MESSAGE
          : UPDATE_FAILED_MESSAGE,
      );
    } finally {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
      isApplyingRef.current = false;
      setIsApplying(false);
    }
  }, [needRefresh, updateServiceWorker]);

  const value = useMemo<PwaUpdateContextValue>(
    () => ({
      hasUpdate: needRefresh[0],
      isApplying,
      applyUpdate,
    }),
    [applyUpdate, isApplying, needRefresh],
  );

  return <PwaUpdateContext.Provider value={value}>{children}</PwaUpdateContext.Provider>;
}
