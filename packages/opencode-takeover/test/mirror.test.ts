import { describe, expect, it } from "vitest";
import { mirrorMessages } from "../src/mirror.ts";
import type { SessionMessage } from "../src/types.ts";

function message(input: SessionMessage): SessionMessage {
  return input;
}

describe("mirrorMessages", () => {
  it("swaps user and assistant roles and summarizes tool parts", () => {
    const mirrored = mirrorMessages([
      message({
        info: { id: "u1", role: "user", time: { created: 1 } },
        parts: [{ type: "text", text: "do the work" }],
      }),
      message({
        info: { id: "a1", role: "assistant", time: { created: 2, completed: 3 } },
        parts: [
          { type: "text", text: "done" },
          { type: "tool", tool: "bash", state: { status: "completed" } },
        ],
      }),
    ]);

    expect(mirrored).toEqual([
      { role: "assistant", content: "do the work" },
      { role: "user", content: "done\n\n[tool:bash:completed]" },
    ]);
  });
});
