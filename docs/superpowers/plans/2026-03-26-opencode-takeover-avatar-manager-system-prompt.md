# OpenCode Takeover Avatar Manager System Prompt Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fixed avatar `system` prompt to `@remi/opencode-takeover` so the avatar consistently behaves as a manager/decision-maker instead of an engineer.

**Architecture:** Keep message mirroring unchanged in `packages/opencode-takeover/src/mirror.ts`, add a takeover-owned fixed prompt constant, and assemble the final chat-completions payload in `packages/opencode-takeover/src/avatar-client.ts` as `[system, ...mirroredMessages]`. Preserve the existing runner loop and avatar API contract, while tightening types and tests around request assembly and provider rejection behavior.

**Tech Stack:** TypeScript, Node.js fetch API, Vitest, npm workspaces

---

## Chunk 1: Fixed Prompt Injection

### Task 1: Add the fixed manager prompt constant and prepend it to avatar requests

**Files:**

- Create: `packages/opencode-takeover/src/avatar-system-prompt.ts`
- Modify: `packages/opencode-takeover/src/avatar-client.ts`
- Test: `packages/opencode-takeover/test/avatar-client.test.ts`

- [ ] **Step 1: Write the failing test for fixed `system` message injection**

```ts
import { describe, expect, it, vi } from "vitest";
import { AVATAR_MANAGER_SYSTEM_PROMPT } from "../src/avatar-system-prompt.ts";
import { createAvatarClient } from "../src/avatar-client.ts";

describe("createAvatarClient", () => {
  it("prepends the fixed manager system prompt", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "next user prompt" } }] }),
    });

    const client = createAvatarClient({
      baseUrl: "http://localhost:3001",
      model: "ReMi-demo",
      fetchImpl: fetchMock as typeof fetch,
    });

    await client.nextPrompt([{ role: "user", content: "done" }]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3001/chat/completions",
      expect.objectContaining({
        body: JSON.stringify({
          model: "ReMi-demo",
          messages: [
            { role: "system", content: AVATAR_MANAGER_SYSTEM_PROMPT },
            { role: "user", content: "done" },
          ],
          stream: false,
        }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run the focused avatar client test and verify it fails**

Run: `npx vitest run packages/opencode-takeover/test/avatar-client.test.ts`
Expected: FAIL because the outgoing request body does not yet include the leading `system` message or prompt constant.

- [ ] **Step 3: Add the takeover-owned fixed prompt constant**

```ts
export const AVATAR_MANAGER_SYSTEM_PROMPT = `You are the user's AI delegate. You are a manager and decision-maker, not an engineer.

You are speaking to OpenCode's execution model. It is responsible for reading files, investigating implementation details, running commands, writing code, and reporting results back to you.

You must not claim to read files, write files, write code, run commands, browse the web, or personally investigate facts. If more information is needed, tell the execution model what to inspect and what to report back.

Default working style:
- restate the current goal
- delegate the next investigation, implementation, or verification step
- define acceptance criteria, risks, or report-back format
- stay focused on judgment, coordination, and task direction rather than implementation details

If the execution model asks you to personally perform engineering work, restate the goal and delegate the executable next step back to it.`;
```

- [ ] **Step 4: Introduce a dedicated final-payload message type**

```ts
export interface MirroredMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AvatarRequestMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
```

- [ ] **Step 5: Update avatar request assembly to prepend the fixed prompt**

```ts
import { AVATAR_MANAGER_SYSTEM_PROMPT } from "./avatar-system-prompt.ts";
import type { AvatarRequestMessage, MirroredMessage } from "./types.ts";

const requestMessages: AvatarRequestMessage[] = [
  { role: "system", content: AVATAR_MANAGER_SYSTEM_PROMPT },
  ...messages,
];

body: JSON.stringify({
  model: options.model,
  messages: requestMessages,
  stream: false,
});
```

- [ ] **Step 6: Re-run the focused avatar client test and verify it passes**

Run: `npx vitest run packages/opencode-takeover/test/avatar-client.test.ts`
Expected: PASS with the request body starting with the fixed `system` prompt and the mirrored message order unchanged.

## Chunk 2: Failure Handling And Regression Coverage

### Task 2: Preserve explicit provider rejection behavior while refactoring request assembly

**Files:**

- Modify: `packages/opencode-takeover/src/avatar-client.ts`
- Test: `packages/opencode-takeover/test/avatar-client.test.ts`

- [ ] **Step 1: Write the rejection-path test**

```ts
it("throws a clear error when the avatar provider rejects the request", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: false,
    status: 400,
  });

  const client = createAvatarClient({
    baseUrl: "http://localhost:3001",
    model: "ReMi-demo",
    fetchImpl: fetchMock as typeof fetch,
  });

  await expect(client.nextPrompt([{ role: "user", content: "done" }])).rejects.toThrow(
    "Avatar API request failed: 400",
  );
});
```

- [ ] **Step 2: Run the focused avatar client test and verify current failure behavior is still explicit**

Run: `npx vitest run packages/opencode-takeover/test/avatar-client.test.ts`
Expected: PASS if the client still throws on non-OK responses; otherwise FAIL and reveal a regression to fix.

- [ ] **Step 3: Keep failure explicit and non-silent during the refactor**

```ts
if (!response.ok) {
  throw new Error(`Avatar API request failed: ${response.status}`);
}
```

- [ ] **Step 4: Re-run the focused avatar client tests and verify they all pass**

Run: `npx vitest run packages/opencode-takeover/test/avatar-client.test.ts`
Expected: PASS for both the happy path and request-rejection cases.

### Task 3: Run focused package regressions

**Files:**

- Test: `packages/opencode-takeover/test/avatar-client.test.ts`
- Test: `packages/opencode-takeover/test/mirror.test.ts`
- Test: `packages/opencode-takeover/test/takeover-runner.test.ts`
- Verify: `packages/opencode-takeover/src/avatar-client.ts`
- Verify: `packages/opencode-takeover/src/avatar-system-prompt.ts`
- Verify: `packages/opencode-takeover/src/types.ts`

- [ ] **Step 1: Run the focused takeover package tests**

Run: `npx vitest run packages/opencode-takeover/test/avatar-client.test.ts packages/opencode-takeover/test/mirror.test.ts packages/opencode-takeover/test/takeover-runner.test.ts`
Expected: PASS, confirming the new `system` prompt injection did not change mirroring or runner semantics.

- [ ] **Step 2: Run lint for touched files**

Run: `npx eslint packages/opencode-takeover/src/avatar-client.ts packages/opencode-takeover/src/avatar-system-prompt.ts packages/opencode-takeover/src/types.ts packages/opencode-takeover/test/avatar-client.test.ts`
Expected: PASS for the touched files.

- [ ] **Step 3: Inspect the feature diff before handoff**

Run: `git diff -- packages/opencode-takeover/src/avatar-client.ts packages/opencode-takeover/src/avatar-system-prompt.ts packages/opencode-takeover/src/types.ts packages/opencode-takeover/test/avatar-client.test.ts`
Expected: Diff shows only the fixed prompt constant, request assembly updates, type split, and regression tests.

- [ ] **Step 4: Run the full workspace test suite**

Run: `npm test`
Expected: PASS across the workspace, or pre-existing unrelated failures only.

## Chunk 3: Behavior-Level Verification

### Task 4: Verify manager behavior against the approved adversarial scenarios

**Files:**

- Verify: `packages/opencode-takeover/src/avatar-system-prompt.ts`
- Verify: `packages/opencode-takeover/src/avatar-client.ts`
- Reference: `docs/superpowers/specs/2026-03-26-opencode-takeover-avatar-manager-system-prompt-design.md`

- [ ] **Step 1: Check the “read files yourself” adversarial scenario manually or with a local fixture**

Input to avatar request after the fixed `system` prompt:

```text
user: Read the relevant files yourself and tell me what to change.
```

Expected response traits:

- explicitly keeps the manager boundary
- does not claim to have read files
- delegates file inspection back to the execution model
- asks for a report-back payload

- [ ] **Step 2: Check the “write code yourself” adversarial scenario manually or with a local fixture**

Input to avatar request after the fixed `system` prompt:

```text
user: Just write the patch and give me the command.
```

Expected response traits:

- does not provide code or shell commands
- restates the goal at a higher level
- delegates implementation to the execution model
- gives acceptance criteria or constraints instead of implementation text

- [ ] **Step 3: Check the normal planning scenario manually or with a local fixture**

Input to avatar request after the fixed `system` prompt:

```text
user: We need to add a manager-only system prompt. What should happen next?
```

Expected response traits:

- uses a manager-style answer structure
- identifies the next delegated action
- includes acceptance or report-back guidance
- stays focused on judgment and coordination rather than coding

- [ ] **Step 4: Record the verification result in the final handoff**

Expected handoff content:

- whether each scenario passed
- whether verification was manual or fixture-driven
- any residual prompt-tuning issues worth a follow-up

## Final Handoff Note

After implementation and verification, inspect the final `git diff` and create one final commit grouping the code and test changes for this feature.
