import { describe, expect, it } from "vitest";
import {
  detectInstallPlatform,
  detectPwaMode,
  shouldPreferBrowserOpenHint,
  type BeforeInstallPromptEvent,
  type InstallPlatform,
  type PlatformSignals,
  type PwaRuntimeSignals,
} from "../../src/lib/pwa-install";

describe("pwa-install helpers", () => {
  it("exports the expected helper types", async () => {
    const platform: InstallPlatform = "ios";
    const runtimeSignals: PwaRuntimeSignals = {
      standaloneMatch: false,
      navigatorStandalone: false,
      referrer: "",
    };
    const platformSignals: PlatformSignals = {
      userAgent: "Mozilla/5.0",
      maxTouchPoints: 0,
    };
    const event = {
      prompt: async () => {},
      userChoice: Promise.resolve({ outcome: "accepted" }),
    } as BeforeInstallPromptEvent;

    // @ts-expect-error referrer is required
    const missingRuntimeReferrer: PwaRuntimeSignals = {
      standaloneMatch: false,
      navigatorStandalone: false,
    };
    // @ts-expect-error maxTouchPoints is required
    const missingTouchPoints: PlatformSignals = {
      userAgent: "Mozilla/5.0",
    };

    expect(platform).toBe("ios");
    expect(runtimeSignals.referrer).toBe("");
    expect(platformSignals.maxTouchPoints).toBe(0);
    expect(event.prompt).toBeTypeOf("function");
    await expect(event.userChoice).resolves.toEqual({ outcome: "accepted" });
    expect(missingRuntimeReferrer).toBeDefined();
    expect(missingTouchPoints).toBeDefined();
  });

  it("detects PWA runtime mode from standalone signals or android app referrer", () => {
    expect(detectPwaMode({ standaloneMatch: true, navigatorStandalone: false, referrer: "" })).toBe(
      true,
    );
    expect(detectPwaMode({ standaloneMatch: false, navigatorStandalone: true, referrer: "" })).toBe(
      true,
    );
    expect(
      detectPwaMode({
        standaloneMatch: false,
        navigatorStandalone: false,
        referrer: "android-app://com.android.chrome",
      }),
    ).toBe(true);
    expect(
      detectPwaMode({
        standaloneMatch: false,
        navigatorStandalone: false,
        referrer: "https://example.test/from/android-app://com.android.chrome",
      }),
    ).toBe(true);
    expect(
      detectPwaMode({
        standaloneMatch: false,
        navigatorStandalone: false,
        referrer: "https://example.test",
      }),
    ).toBe(false);
  });

  it("detects install platforms from common mobile and desktop user agents", () => {
    expect(
      detectInstallPlatform({
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
        maxTouchPoints: 5,
      }),
    ).toBe("ios");
    expect(
      detectInstallPlatform({
        userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
        maxTouchPoints: 5,
      }),
    ).toBe("ios");
    expect(
      detectInstallPlatform({
        userAgent:
          "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15",
        maxTouchPoints: 5,
      }),
    ).toBe("ios");
    expect(
      detectInstallPlatform({
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125.0.0.0 Mobile Safari/537.36",
        maxTouchPoints: 5,
      }),
    ).toBe("android");
    expect(
      detectInstallPlatform({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15",
        maxTouchPoints: 5,
      }),
    ).toBe("unknown");
    expect(
      detectInstallPlatform({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
        maxTouchPoints: 0,
      }),
    ).toBe("desktop");
    expect(
      detectInstallPlatform({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
        maxTouchPoints: 0,
      }),
    ).toBe("desktop");
    expect(
      detectInstallPlatform({
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
        maxTouchPoints: 0,
      }),
    ).toBe("desktop");
    expect(detectInstallPlatform({ userAgent: "CustomAgent/1.0", maxTouchPoints: 0 })).toBe(
      "unknown",
    );
  });

  it("prefers browser-open hints for restricted in-app browsers", () => {
    expect(
      shouldPreferBrowserOpenHint(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 [FBAN/FBIOS;FBAV/455.0.0.0.45]",
      ),
    ).toBe(true);
    expect(
      shouldPreferBrowserOpenHint(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Instagram 350.1.0.0.12",
      ),
    ).toBe(true);
    expect(
      shouldPreferBrowserOpenHint(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 MicroMessenger/8.0.49",
      ),
    ).toBe(true);
    expect(
      shouldPreferBrowserOpenHint(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe(false);
  });
});
