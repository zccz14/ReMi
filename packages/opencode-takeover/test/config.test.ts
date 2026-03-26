import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";

describe("parseConfig", () => {
  it("parses required CLI flags for the takeover demo", () => {
    const config = parseConfig([
      "--session-id=ses_demo",
      "--write-api-confirmed=true",
      "--avatar-base-url=http://localhost:3001",
      "--avatar-model=ReMi-demo",
    ]);

    expect(config.sessionId).toBe("ses_demo");
    expect(config.writeApiConfirmed).toBe(true);
    expect(config.avatarBaseUrl).toBe("http://localhost:3001");
    expect(config.avatarModel).toBe("ReMi-demo");
    expect(config.opencodeBaseUrl).toBe("http://localhost:4096");
    expect(config.windowSize).toBe(8);
    expect(config.pollMs).toBe(2000);
  });

  it("throws when write-api-confirmed is missing", () => {
    expect(() =>
      parseConfig([
        "--session-id=ses_demo",
        "--avatar-base-url=http://localhost:3001",
        "--avatar-model=ReMi-demo",
      ]),
    ).toThrow(/write-api-confirmed/i);
  });
});
