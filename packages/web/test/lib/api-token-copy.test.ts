import { describe, expect, it } from "vitest";
import en from "../../public/locales/en/translation.json";
import zh from "../../public/locales/zh/translation.json";

describe("api token settings copy", () => {
  it("describes the simplified token model without one-time visibility promises", () => {
    expect(en.settings.apiTokensDescription).toBe(
      "Create and revoke tokens for calling your avatar API. Token IDs are the full bearer tokens.",
    );
    expect(en.settings.apiTokenCreatedDescription).toBe(
      "Use this token as the Bearer value when calling your avatar API.",
    );

    expect(zh.settings.apiTokensDescription).toBe(
      "创建和吊销用于调用你的分身 API 的 token。token ID 就是完整的 bearer token。",
    );
    expect(zh.settings.apiTokenCreatedDescription).toBe(
      "调用你的分身 API 时，把这个 token 作为 Bearer 值使用。",
    );
  });
});
