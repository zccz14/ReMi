import { mirrorMessages } from "./mirror.ts";
import type { OpencodeClient } from "./opencode-client.ts";
import { evaluateTurnState } from "./turn-state.ts";
import type { AnchorStatus, SessionMessage } from "./types.ts";

type Logger = Pick<Console, "info" | "warn" | "error">;

export interface TakeoverRunner {
  tick(): Promise<void>;
}

export function createTakeoverRunner(input: {
  sessionId: string;
  windowSize: number;
  opencode: OpencodeClient;
  avatar: {
    nextPrompt(messages: Array<{ role: "user" | "assistant"; content: string }>): Promise<string>;
  };
  logger: Logger;
}): TakeoverRunner {
  const anchors = new Map<string, AnchorStatus>();
  let consecutivePollFailures = 0;

  async function listMessages() {
    try {
      const messages = await input.opencode.listMessages(input.sessionId, input.windowSize);
      consecutivePollFailures = 0;
      return messages;
    } catch (error) {
      consecutivePollFailures += 1;
      input.logger.warn(
        `poll failed (${consecutivePollFailures}/20): ${error instanceof Error ? error.message : String(error)}`,
      );
      if (consecutivePollFailures >= 20) {
        throw new Error("OpenCode polling failed 20 times consecutively", {
          cause: error,
        });
      }
      return null;
    }
  }

  return {
    async tick() {
      const messages = await listMessages();
      if (!messages) return;

      const state = evaluateTurnState(messages as SessionMessage[], anchors);
      if (state.kind === "busy") {
        input.logger.info("turn busy");
        return;
      }
      if (state.kind === "ambiguous") {
        input.logger.warn(`turn ambiguous: ${state.reason}`);
        return;
      }

      anchors.set(state.anchorId, "write_pending");
      const mirrored = mirrorMessages(messages);
      let prompt: string;
      try {
        prompt = await input.avatar.nextPrompt(mirrored);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const incompatibilityHint =
          /(system[- ]?message|request[- ]?validation|request validation)/i.test(errorMessage)
            ? "; possible system-message/request-validation incompatibility"
            : "";
        input.logger.warn(
          `avatar request failed for anchor ${state.anchorId}: ${errorMessage}${incompatibilityHint}`,
        );
        return;
      }
      if (prompt.trim() === "") {
        input.logger.warn(`avatar returned empty reply for anchor ${state.anchorId}`);
        return;
      }
      await input.opencode.writePrompt(input.sessionId, prompt);
      anchors.set(state.anchorId, "committed");
      input.logger.info(`processed anchor ${state.anchorId}`);
    },
  };
}
