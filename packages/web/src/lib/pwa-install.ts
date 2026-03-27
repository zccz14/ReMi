export type InstallPlatform = "ios" | "android" | "desktop" | "unknown";

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice?: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface PwaRuntimeSignals {
  standaloneMatch: boolean;
  navigatorStandalone: boolean;
  referrer: string;
}

export interface PlatformSignals {
  userAgent: string;
  maxTouchPoints: number;
}

export function detectPwaMode({
  standaloneMatch,
  navigatorStandalone,
  referrer,
}: PwaRuntimeSignals): boolean {
  return standaloneMatch || navigatorStandalone || referrer.includes("android-app://");
}

export function detectInstallPlatform({
  userAgent,
  maxTouchPoints,
}: PlatformSignals): InstallPlatform {
  if (/iPhone|iPod|iPad/i.test(userAgent)) {
    return "ios";
  }

  if (/Android/i.test(userAgent)) {
    return "android";
  }

  if (/Macintosh/i.test(userAgent) && maxTouchPoints > 1) {
    return "unknown";
  }

  if (/Macintosh|Windows|Linux/i.test(userAgent)) {
    return "desktop";
  }

  return "unknown";
}

export function shouldPreferBrowserOpenHint(userAgent: string): boolean {
  return /FBAV|Instagram|MicroMessenger/i.test(userAgent);
}
