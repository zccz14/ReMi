import { describe, expect, it } from "vitest";
import {
  detectInstallPlatform,
  detectPwaMode,
  shouldPreferBrowserOpenHint,
} from "../../src/lib/pwa-install";

describe("pwa-install helpers", () => {
  it("detects standalone display mode as PWA runtime", () => {
    expect(detectPwaMode({ standaloneMatch: true, navigatorStandalone: false, referrer: "" })).toBe(
      true,
    );
  });

  it("detects navigator standalone as PWA runtime", () => {
    expect(detectPwaMode({ standaloneMatch: false, navigatorStandalone: true, referrer: "" })).toBe(
      true,
    );
  });

  it("returns false when no runtime signal is present", () => {
    expect(
      detectPwaMode({ standaloneMatch: false, navigatorStandalone: false, referrer: "" }),
    ).toBe(false);
  });

  it("detects the minimal approved install platforms", () => {
    expect(
      detectInstallPlatform({
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
        maxTouchPoints: 5,
      }),
    ).toBe("ios");
    expect(
      detectInstallPlatform({
        userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8)",
        maxTouchPoints: 5,
      }),
    ).toBe("android");
    expect(
      detectInstallPlatform({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) Chrome/125.0.0.0 Safari/537.36",
        maxTouchPoints: 0,
      }),
    ).toBe("desktop");
    expect(
      detectInstallPlatform({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) Version/17.4 Safari/605.1.15",
        maxTouchPoints: 5,
      }),
    ).toBe("unknown");
  });

  it("detects the minimal approved restricted hosts", () => {
    expect(shouldPreferBrowserOpenHint("Mozilla/5.0 AppleWebKit/605.1.15 FBAV/455.0.0.0.45")).toBe(
      true,
    );
    expect(
      shouldPreferBrowserOpenHint("Mozilla/5.0 AppleWebKit/605.1.15 MicroMessenger/8.0.49"),
    ).toBe(true);
    expect(
      shouldPreferBrowserOpenHint(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe(false);
  });
});
