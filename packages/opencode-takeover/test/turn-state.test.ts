import { describe, expect, it } from "vitest";
import { evaluateTurnState } from "../src/turn-state.ts";
import type { SessionMessage } from "../src/types.ts";

function message(input: SessionMessage): SessionMessage {
  return input;
}

describe("evaluateTurnState", () => {
  it("returns busy when the tail assistant has a running tool", () => {
    const state = evaluateTurnState([
      message({
        info: { id: "a1", role: "assistant", time: { created: 1 } },
        parts: [{ type: "tool", tool: "bash", state: { status: "running" } }],
      }),
    ]);

    expect(state).toEqual({ kind: "busy" });
  });

  it("returns ambiguous when the tail message is not assistant", () => {
    const state = evaluateTurnState([
      message({
        info: { id: "u1", role: "user", time: { created: 1 } },
        parts: [{ type: "text", text: "next" }],
      }),
    ]);

    expect(state.kind).toBe("ambiguous");
  });

  it("returns idle-runnable for a completed unprocessed assistant", () => {
    const state = evaluateTurnState([
      message({
        info: { id: "a1", role: "assistant", time: { created: 1, completed: 2 } },
        parts: [{ type: "text", text: "done" }],
      }),
    ]);

    expect(state).toEqual({ kind: "idle-runnable", anchorId: "a1" });
  });

  it("returns ambiguous for an already committed assistant anchor", () => {
    const state = evaluateTurnState(
      [
        message({
          info: { id: "a1", role: "assistant", time: { created: 1, completed: 2 } },
          parts: [{ type: "text", text: "done" }],
        }),
      ],
      new Map([["a1", "committed"]]),
    );

    expect(state.kind).toBe("ambiguous");
  });
});
