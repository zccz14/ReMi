import { describe, expect, it } from "vitest";
import en from "../../public/locales/en/translation.json";
import zh from "../../public/locales/zh/translation.json";

describe("api token settings copy", () => {
  it("describes UI visibility without promising the token only exists once", () => {
    expect(en.settings.apiTokensDescription).toBe(
      "Create and revoke tokens for calling your avatar API. Newly created tokens are shown in full below.",
    );
    expect(en.settings.apiTokenCreatedDescription).toBe(
      "Copy this token now. The settings list will show only its prefix.",
    );

    expect(zh.settings.apiTokensDescription).toBe(
      "创建和吊销用于调用你的分身 API 的 token。新创建的 token 会在下方完整显示。",
    );
    expect(zh.settings.apiTokenCreatedDescription).toBe(
      "请现在复制这个 token。设置页列表只会显示它的前缀。",
    );
  });
});
