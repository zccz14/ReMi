import { describe, expect, it } from "vitest";
import en from "../../public/locales/en/translation.json";
import zh from "../../public/locales/zh/translation.json";

describe("pwa update copy", () => {
  it("contains the required update keys in both locales", () => {
    for (const locale of [en, zh]) {
      expect(locale).toHaveProperty("me.update.cta");
      expect(locale).toHaveProperty("me.update.applying");
      expect(locale).toHaveProperty("me.update.stale");
      expect(locale).toHaveProperty("me.update.failed");
      expect(locale).toHaveProperty("me.update.timeout");
    }
  });
});
