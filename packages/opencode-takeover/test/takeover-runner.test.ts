import { describe, expect, it, vi } from "vitest";
import { createTakeoverRunner } from "../src/takeover-runner.ts";
import type { SessionMessage } from "../src/types.ts";

function assistantMessage(overrides?: Partial<SessionMessage>): SessionMessage {
  return {
    info: { id: "a1", role: "assistant", time: { created: 1, completed: 2 } },
    parts: [{ type: "text", text: "done" }],
    ...overrides,
  } as SessionMessage;
}

describe("createTakeoverRunner", () => {
  it("calls avatar once for a completed unprocessed assistant turn", async () => {
    const opencode = {
      getSession: vi.fn().mockResolvedValue({ id: "ses_demo" }),
      listMessages: vi.fn().mockResolvedValue([assistantMessage()]),
      writePrompt: vi.fn().mockResolvedValue(undefined),
    };
    const avatar = { nextPrompt: vi.fn().mockResolvedValue("continue") };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const runner = createTakeoverRunner({
      sessionId: "ses_demo",
      windowSize: 8,
      opencode,
      avatar,
      logger,
    });
    await runner.tick();

    expect(avatar.nextPrompt).toHaveBeenCalledTimes(1);
    expect(opencode.writePrompt).toHaveBeenCalledWith("ses_demo", "continue");
  });

  it("does not call avatar for busy turns", async () => {
    const opencode = {
      getSession: vi.fn().mockResolvedValue({ id: "ses_demo" }),
      listMessages: vi.fn().mockResolvedValue([
        assistantMessage({
          info: { id: "a1", role: "assistant", time: { created: 1 } },
          parts: [{ type: "tool", tool: "bash", state: { status: "running" } }],
        }),
      ]),
      writePrompt: vi.fn(),
    };
    const avatar = { nextPrompt: vi.fn() };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const runner = createTakeoverRunner({
      sessionId: "ses_demo",
      windowSize: 8,
      opencode,
      avatar,
      logger,
    });
    await runner.tick();

    expect(avatar.nextPrompt).not.toHaveBeenCalled();
    expect(opencode.writePrompt).not.toHaveBeenCalled();
  });

  it("does not write empty avatar replies", async () => {
    const opencode = {
      getSession: vi.fn().mockResolvedValue({ id: "ses_demo" }),
      listMessages: vi.fn().mockResolvedValue([assistantMessage()]),
      writePrompt: vi.fn(),
    };
    const avatar = { nextPrompt: vi.fn().mockResolvedValue("   ") };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const runner = createTakeoverRunner({
      sessionId: "ses_demo",
      windowSize: 8,
      opencode,
      avatar,
      logger,
    });
    await runner.tick();

    expect(opencode.writePrompt).not.toHaveBeenCalled();
  });

  it("preserves surrounding whitespace when writing a non-empty avatar reply", async () => {
    const opencode = {
      getSession: vi.fn().mockResolvedValue({ id: "ses_demo" }),
      listMessages: vi.fn().mockResolvedValue([assistantMessage()]),
      writePrompt: vi.fn().mockResolvedValue(undefined),
    };
    const avatar = { nextPrompt: vi.fn().mockResolvedValue("  continue  ") };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const runner = createTakeoverRunner({
      sessionId: "ses_demo",
      windowSize: 8,
      opencode,
      avatar,
      logger,
    });
    await runner.tick();

    expect(opencode.writePrompt).toHaveBeenCalledWith("ses_demo", "  continue  ");
  });

  it("logs and skips write when the avatar request fails", async () => {
    const opencode = {
      getSession: vi.fn().mockResolvedValue({ id: "ses_demo" }),
      listMessages: vi.fn().mockResolvedValue([assistantMessage()]),
      writePrompt: vi.fn(),
    };
    const avatar = {
      nextPrompt: vi.fn().mockRejectedValue(new Error("provider rejected system message")),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const runner = createTakeoverRunner({
      sessionId: "ses_demo",
      windowSize: 8,
      opencode,
      avatar,
      logger,
    });
    await runner.tick();

    expect(opencode.writePrompt).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/avatar request failed.*provider rejected system message/i),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("system-message/request-validation incompatibility"),
    );
  });

  it("does not add the incompatibility hint for unrelated avatar failures", async () => {
    const opencode = {
      getSession: vi.fn().mockResolvedValue({ id: "ses_demo" }),
      listMessages: vi.fn().mockResolvedValue([assistantMessage()]),
      writePrompt: vi.fn(),
    };
    const avatar = {
      nextPrompt: vi.fn().mockRejectedValue(new Error("network timeout")),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const runner = createTakeoverRunner({
      sessionId: "ses_demo",
      windowSize: 8,
      opencode,
      avatar,
      logger,
    });
    await runner.tick();

    expect(opencode.writePrompt).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/avatar request failed.*network timeout/i),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("system-message/request-validation incompatibility"),
    );
  });

  it("does not process the same assistant anchor twice", async () => {
    const opencode = {
      getSession: vi.fn().mockResolvedValue({ id: "ses_demo" }),
      listMessages: vi.fn().mockResolvedValue([assistantMessage()]),
      writePrompt: vi.fn().mockResolvedValue(undefined),
    };
    const avatar = { nextPrompt: vi.fn().mockResolvedValue("continue") };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const runner = createTakeoverRunner({
      sessionId: "ses_demo",
      windowSize: 8,
      opencode,
      avatar,
      logger,
    });
    await runner.tick();
    await runner.tick();

    expect(avatar.nextPrompt).toHaveBeenCalledTimes(1);
  });

  it("throws after 20 consecutive poll failures", async () => {
    const opencode = {
      getSession: vi.fn().mockResolvedValue({ id: "ses_demo" }),
      listMessages: vi.fn().mockRejectedValue(new Error("boom")),
      writePrompt: vi.fn(),
    };
    const avatar = { nextPrompt: vi.fn() };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const runner = createTakeoverRunner({
      sessionId: "ses_demo",
      windowSize: 8,
      opencode,
      avatar,
      logger,
    });

    for (let i = 0; i < 19; i += 1) {
      await runner.tick();
    }

    await expect(runner.tick()).rejects.toThrow(/20/i);
  });
});
