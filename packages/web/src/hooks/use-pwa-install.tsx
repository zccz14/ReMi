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
import {
  detectInstallPlatform,
  detectPwaMode,
  shouldPreferBrowserOpenHint,
  type BeforeInstallPromptEvent,
  type InstallPlatform,
} from "../lib/pwa-install";

interface PwaInstallContextValue {
  isPwaMode: boolean;
  platform: InstallPlatform;
  isGuideOpen: boolean;
  shouldShowBrowserOpenHint: boolean;
  installOrShowGuide: () => Promise<void>;
  closeGuide: () => void;
}

const PwaInstallContext = createContext<PwaInstallContextValue | null>(null);

function getBrowserSignals() {
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    typeof document === "undefined"
  ) {
    return {
      userAgent: "",
      maxTouchPoints: 0,
      standaloneMatch: false,
      navigatorStandalone: false,
      referrer: "",
    };
  }

  return {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    standaloneMatch: window.matchMedia?.("(display-mode: standalone)").matches ?? false,
    navigatorStandalone: window.navigator.standalone === true,
    referrer: document.referrer,
  };
}

export function usePwaInstall(): PwaInstallContextValue {
  const context = useContext(PwaInstallContext);

  if (!context) {
    throw new Error("usePwaInstall must be used within PwaInstallProvider");
  }

  return context;
}

export function PwaInstallProvider({ children }: { children: ReactNode }) {
  const promptEventRef = useRef<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [isGuideOpen, setIsGuideOpen] = useState(false);
  const browserSignals = getBrowserSignals();

  const platform = detectInstallPlatform({
    userAgent: browserSignals.userAgent,
    maxTouchPoints: browserSignals.maxTouchPoints,
  });
  const shouldShowBrowserOpenHint = shouldPreferBrowserOpenHint(browserSignals.userAgent);
  const isPwaMode =
    installed ||
    detectPwaMode({
      standaloneMatch: browserSignals.standaloneMatch,
      navigatorStandalone: browserSignals.navigatorStandalone,
      referrer: browserSignals.referrer,
    });

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleBeforeInstallPrompt = (event: Event) => {
      const installEvent = event as BeforeInstallPromptEvent;
      installEvent.preventDefault();
      promptEventRef.current = installEvent;
    };

    const handleAppInstalled = () => {
      setInstalled(true);
      promptEventRef.current = null;
      setIsGuideOpen(false);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const closeGuide = useCallback(() => {
    setIsGuideOpen(false);
  }, []);

  const installOrShowGuide = useCallback(async () => {
    const promptEvent = promptEventRef.current;

    if (!promptEvent) {
      setIsGuideOpen(true);
      return;
    }

    promptEventRef.current = null;

    try {
      await promptEvent.prompt();
      await promptEvent.userChoice;
    } catch {
      setIsGuideOpen(true);
    }
  }, []);

  const value = useMemo<PwaInstallContextValue>(
    () => ({
      isPwaMode,
      platform,
      isGuideOpen,
      shouldShowBrowserOpenHint,
      installOrShowGuide,
      closeGuide,
    }),
    [closeGuide, installOrShowGuide, isGuideOpen, isPwaMode, platform, shouldShowBrowserOpenHint],
  );

  return <PwaInstallContext.Provider value={value}>{children}</PwaInstallContext.Provider>;
}
