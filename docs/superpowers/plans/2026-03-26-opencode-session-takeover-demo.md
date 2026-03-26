# OpenCode Session Takeover Demo Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an experimental standalone package that polls one OpenCode session, mirrors recent messages into avatar input, calls the avatar once per completed assistant turn, and sends the avatar reply back as the next OpenCode prompt.

**Architecture:** Add a new workspace package under `packages/` with a small CLI entrypoint plus focused modules for OpenCode API access, message extraction/mirroring, takeover state machine, avatar adapter, and runtime config. Keep the implementation intentionally minimal for a demo: in-memory anchor tracking, polling only, fixed write API contract, and simple console logging.

**Tech Stack:** TypeScript, Node.js built-in `fetch`, workspace package scripts, Vitest

---

## Chunk 1: Package Skeleton And Config

### Task 1: Create standalone workspace package

**Files:**

- Create: `packages/opencode-takeover/package.json`
- Create: `packages/opencode-takeover/tsconfig.json`
- Create: `packages/opencode-takeover/src/index.ts`
- Create: `packages/opencode-takeover/src/config.ts`
- Test: `packages/opencode-takeover/test/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../packages/opencode-takeover/src/config.js";

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
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/opencode-takeover/test/config.test.ts`
Expected: FAIL because `packages/opencode-takeover/src/config.ts` does not exist yet

- [ ] **Step 3: Write minimal implementation**

Create a minimal package with:

```json
{
  "name": "@remi/opencode-takeover",
  "private": true,
  "type": "module",
  "scripts": {
    "engines": {
      "node": ">=22.0.0"
    },
    "start": "node --experimental-strip-types src/index.ts"
  }
}
```

And a simple config parser:

```ts
export interface TakeoverConfig {
  sessionId: string;
  writeApiConfirmed: boolean;
  avatarBaseUrl: string;
  avatarModel: string;
  opencodeBaseUrl: string;
  pollMs: number;
  windowSize: number;
}

export function parseConfig(argv: string[]): TakeoverConfig {
  // minimal flag parser for required fields
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/opencode-takeover/test/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode-takeover/package.json packages/opencode-takeover/tsconfig.json packages/opencode-takeover/src/index.ts packages/opencode-takeover/src/config.ts packages/opencode-takeover/test/config.test.ts
git commit -m "feat: scaffold opencode takeover demo package"
```

### Task 2: Fail fast on missing required runtime confirmation

**Files:**

- Modify: `packages/opencode-takeover/src/config.ts`
- Test: `packages/opencode-takeover/test/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("throws when write-api-confirmed is missing", () => {
  expect(() =>
    parseConfig([
      "--session-id=ses_demo",
      "--avatar-base-url=http://localhost:3001",
      "--avatar-model=ReMi-demo",
    ]),
  ).toThrow(/write-api-confirmed/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/opencode-takeover/test/config.test.ts`
Expected: FAIL because the parser does not reject missing confirmation yet

- [ ] **Step 3: Write minimal implementation**

Update `parseConfig()` to require:

- `--session-id`
- `--write-api-confirmed=true`
- `--avatar-base-url`
- `--avatar-model`

Throw a clear `Error` when any required flag is missing or invalid.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/opencode-takeover/test/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode-takeover/src/config.ts packages/opencode-takeover/test/config.test.ts
git commit -m "test: require explicit takeover runtime flags"
```

## Chunk 2: Mirror And Trigger Logic

### Task 3: Implement assistant-tail status detection

**Files:**

- Create: `packages/opencode-takeover/src/types.ts`
- Create: `packages/opencode-takeover/src/turn-state.ts`
- Test: `packages/opencode-takeover/test/turn-state.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { evaluateTurnState } from "../../packages/opencode-takeover/src/turn-state.js";

describe("evaluateTurnState", () => {
  it("returns busy when the tail assistant has a running tool", () => {
    const state = evaluateTurnState([
      {
        info: { id: "a1", role: "assistant", time: { created: 1 } },
        parts: [{ type: "tool", tool: "bash", state: { status: "running" } }],
      },
    ]);

    expect(state.kind).toBe("busy");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/opencode-takeover/test/turn-state.test.ts`
Expected: FAIL because `turn-state.ts` does not exist yet

- [ ] **Step 3: Write minimal implementation**

Implement:

```ts
export type TurnState =
  | { kind: "busy" }
  | { kind: "ambiguous"; reason: string }
  | { kind: "idle-runnable"; anchorId: string };

export function evaluateTurnState(messages: SessionMessage[]): TurnState {
  // exact order from the approved spec
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/opencode-takeover/test/turn-state.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode-takeover/src/types.ts packages/opencode-takeover/src/turn-state.ts packages/opencode-takeover/test/turn-state.test.ts
git commit -m "feat: add takeover turn state evaluation"
```

### Task 4: Implement fixed message mirroring

**Files:**

- Create: `packages/opencode-takeover/src/mirror.ts`
- Test: `packages/opencode-takeover/test/mirror.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { mirrorMessages } from "../../packages/opencode-takeover/src/mirror.js";

describe("mirrorMessages", () => {
  it("swaps user and assistant roles and summarizes tool parts", () => {
    const mirrored = mirrorMessages([
      {
        info: { id: "u1", role: "user", time: { created: 1 } },
        parts: [{ type: "text", text: "do the work" }],
      },
      {
        info: { id: "a1", role: "assistant", time: { created: 2, completed: 3 } },
        parts: [
          { type: "text", text: "done" },
          { type: "tool", tool: "bash", state: { status: "completed" } },
        ],
      },
    ]);

    expect(mirrored).toEqual([
      { role: "assistant", content: "do the work" },
      { role: "user", content: "done\n\n[tool:bash:completed]" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/opencode-takeover/test/mirror.test.ts`
Expected: FAIL because `mirror.ts` does not exist yet

- [ ] **Step 3: Write minimal implementation**

Implement the exact approved extraction rules:

- keep only `user`/`assistant` messages
- keep `text` parts in original order
- add `[tool:<tool-name>:<status>]` synthetic lines for tool parts
- ignore reasoning/patch/snapshot/step parts
- drop empty messages
- swap `user` and `assistant` roles

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/opencode-takeover/test/mirror.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode-takeover/src/mirror.ts packages/opencode-takeover/test/mirror.test.ts
git commit -m "feat: add fixed session mirroring rules"
```

## Chunk 3: OpenCode And Avatar Adapters

### Task 5: Implement minimal OpenCode HTTP client

**Files:**

- Create: `packages/opencode-takeover/src/opencode-client.ts`
- Test: `packages/opencode-takeover/test/opencode-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { createOpencodeClient } from "../../packages/opencode-takeover/src/opencode-client.js";

describe("createOpencodeClient", () => {
  it("posts takeover prompts with the fixed request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ info: { role: "assistant" } }),
    });

    const client = createOpencodeClient("http://localhost:4096", fetchMock as typeof fetch);
    await client.writePrompt("ses_demo", "next prompt");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4096/session/ses_demo/message",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/opencode-takeover/test/opencode-client.test.ts`
Expected: FAIL because `opencode-client.ts` does not exist yet

- [ ] **Step 3: Write minimal implementation**

Implement `createOpencodeClient()` with only three methods:

- `getSession(sessionId)`
- `listMessages(sessionId, limit)`
- `writePrompt(sessionId, text)`

`writePrompt()` must POST:

```json
{
  "parts": [{ "type": "text", "text": "..." }]
}
```

and only accept responses that satisfy:

- HTTP 200
- response JSON has `info`
- `info.role === "assistant"`

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/opencode-takeover/test/opencode-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode-takeover/src/opencode-client.ts packages/opencode-takeover/test/opencode-client.test.ts
git commit -m "feat: add minimal opencode takeover client"
```

### Task 6: Implement minimal avatar adapter

**Files:**

- Create: `packages/opencode-takeover/src/avatar-client.ts`
- Test: `packages/opencode-takeover/test/avatar-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { createAvatarClient } from "../../packages/opencode-takeover/src/avatar-client.js";

describe("createAvatarClient", () => {
  it("returns the full assistant text from the avatar API", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "next user prompt" } }] }),
    });

    const client = createAvatarClient({
      baseUrl: "http://localhost:3001",
      model: "ReMi-demo",
      fetchImpl: fetchMock as typeof fetch,
    });

    const reply = await client.nextPrompt([{ role: "user", content: "done" }]);
    expect(reply).toBe("next user prompt");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/opencode-takeover/test/avatar-client.test.ts`
Expected: FAIL because `avatar-client.ts` does not exist yet

- [ ] **Step 3: Write minimal implementation**

Implement a very small OpenAI-compatible avatar adapter:

```ts
await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model, messages, stream: false }),
});
```

Return only `choices[0].message.content.trim()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/opencode-takeover/test/avatar-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode-takeover/src/avatar-client.ts packages/opencode-takeover/test/avatar-client.test.ts
git commit -m "feat: add minimal avatar takeover adapter"
```

## Chunk 4: Poll Loop And CLI

### Task 7: Implement in-memory takeover loop

**Files:**

- Create: `packages/opencode-takeover/src/takeover-runner.ts`
- Modify: `packages/opencode-takeover/src/index.ts`
- Test: `packages/opencode-takeover/test/takeover-runner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { createTakeoverRunner } from "../../packages/opencode-takeover/src/takeover-runner.js";

describe("createTakeoverRunner", () => {
  it("calls avatar once for a completed unprocessed assistant turn", async () => {
    const opencode = {
      listMessages: vi.fn().mockResolvedValue([
        {
          info: { id: "a1", role: "assistant", time: { created: 1, completed: 2 } },
          parts: [{ type: "text", text: "done" }],
        },
      ]),
      writePrompt: vi.fn().mockResolvedValue(undefined),
    };
    const avatar = { nextPrompt: vi.fn().mockResolvedValue("continue") };

    const runner = createTakeoverRunner({
      sessionId: "ses_demo",
      windowSize: 8,
      opencode,
      avatar,
      logger: console,
    });
    await runner.tick();

    expect(avatar.nextPrompt).toHaveBeenCalledTimes(1);
    expect(opencode.writePrompt).toHaveBeenCalledWith("ses_demo", "continue");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/opencode-takeover/test/takeover-runner.test.ts`
Expected: FAIL because `takeover-runner.ts` does not exist yet

- [ ] **Step 3: Write minimal implementation**

Implement:

- `tick()` for one poll cycle
- in-memory `Set<string>` or small state map for committed anchors
- exact state evaluation + mirroring + avatar call + OpenCode write
- ambiguous/busy logging paths

Then make `src/index.ts` run an infinite loop:

```ts
while (true) {
  await runner.tick();
  await sleep(config.pollMs);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/opencode-takeover/test/takeover-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode-takeover/src/index.ts packages/opencode-takeover/src/takeover-runner.ts packages/opencode-takeover/test/takeover-runner.test.ts
git commit -m "feat: add polling takeover demo loop"
```

### Task 8: Add package-level run script and README usage

**Files:**

- Modify: `packages/opencode-takeover/package.json`
- Create: `packages/opencode-takeover/README.md`

- [ ] **Step 1: Write the failing test**

Skip automated test here; this task is documentation and package script wiring.

- [ ] **Step 2: Run package entry manually to verify failure mode is clear**

Run: `node packages/opencode-takeover/src/index.ts`
Expected: exits with a clear missing-flag error

- [ ] **Step 3: Write minimal implementation**

Add scripts like:

```json
{
  "scripts": {
    "engines": {
      "node": ">=22.0.0"
    },
    "start": "node --experimental-strip-types src/index.ts"
  }
}
```

Document exact demo startup in `packages/opencode-takeover/README.md`, including:

- required flags
- example command
- note that `--write-api-confirmed=true` is mandatory
- note that this is single-session, polling-only, in-memory demo code

- [ ] **Step 4: Run manual verification**

Run: `node packages/opencode-takeover/src/index.ts --session-id=ses_demo --write-api-confirmed=true --avatar-base-url=http://localhost:3001 --avatar-model=ReMi-demo`
Expected: either starts polling or fails with a clear OpenCode/session connectivity error

- [ ] **Step 5: Commit**

```bash
git add packages/opencode-takeover/package.json packages/opencode-takeover/README.md
git commit -m "docs: add takeover demo startup instructions"
```
