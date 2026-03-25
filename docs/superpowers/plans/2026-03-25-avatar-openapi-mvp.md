# Avatar OpenAPI MVP Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-serve OpenAI-style avatar inference API at `POST /ai/v1/chat/completions`, plus owner-managed API tokens, so a user can call their own ReMi avatar with `model = ReMi-<pubKey>`.

**Architecture:** Add a thin `/ai` protocol adapter on top of a new protocol-neutral avatar inference runtime. Store API tokens inside each owner's SQLite database, manage them through existing owner-authenticated `/api/:pubKey/*` routes, then resolve `/ai` requests by parsing `model`, opening the target user DB, validating the bearer token, augmenting messages with stable avatar context and dynamic recall, and finally adapting runtime output back into OpenAI-style JSON or SSE.

**Tech Stack:** Hono, Drizzle + better-sqlite3, existing per-user SQLite connection manager, existing reasoning/recall runtime, existing web auth + settings page UI, Vitest integration tests.

---

## File Map

**Server entry / wiring**

- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/index.ts` only if new config/env is needed

**Database**

- Modify: `packages/server/src/db/schema.ts`
- Modify: `packages/server/src/db/migrate.ts`
- Possibly create: `packages/server/src/db/api-tokens.ts` for focused token CRUD helpers

**Owner token management APIs**

- Create: `packages/server/src/routes/api-tokens.ts`
- Modify: `packages/server/src/app.ts`

**Avatar inference runtime + AI protocol adapter**

- Create: `packages/server/src/avatar/runtime.ts`
- Create: `packages/server/src/avatar/openai-chat.ts`
- Create: `packages/server/src/routes/ai-chat-completions.ts`
- Modify: `packages/server/src/llm/client.ts`
- Possibly modify: `packages/server/src/reasoning/engine.ts` only when extracting reusable recall/building blocks is cleaner than duplicating logic
- Possibly create: `packages/server/src/avatar/message-augmentation.ts`
- Possibly create: `packages/server/src/avatar/model.ts`

**Web token management UI**

- Modify: `packages/web/src/pages/SettingsPage.tsx`
- Modify: `packages/web/src/lib/api-client.ts`
- Possibly create: `packages/web/src/lib/api-tokens.ts`

**Tests**

- Modify: `test/server-integration.test.ts`
- Create: `test/avatar-openapi-integration.test.ts`
- Possibly create: `packages/server/test/avatar-runtime.test.ts`

## Chunk 1: Token Storage And Owner Management APIs

### Task 1: Add `api_tokens` storage to per-user SQLite

**Files:**

- Modify: `packages/server/src/db/schema.ts`
- Modify: `packages/server/src/db/migrate.ts`
- Test: `test/server-integration.test.ts`

- [ ] **Step 1: Write the failing integration test for token CRUD**

Add a server integration test that:

- creates an owner-authenticated token via `POST /api/:pubKey/api-tokens`
- lists it via `GET /api/:pubKey/api-tokens`
- deletes it via `DELETE /api/:pubKey/api-tokens/:id`
- verifies the deleted token no longer appears in the list

Example assertions to add in `test/server-integration.test.ts`:

```ts
expect(createRes.status).toBe(201);
expect(createJson.id.startsWith("sk-")).toBe(true);

expect(listRes.status).toBe(200);
expect(listJson.items).toHaveLength(1);
expect(listJson.items[0].tokenPrefix.startsWith("sk-")).toBe(true);

expect(deleteRes.status).toBe(204);
expect(listAfterDeleteJson.items).toHaveLength(0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/server-integration.test.ts`

Expected: FAIL with missing route / missing table / missing handler errors.

- [ ] **Step 3: Add the new schema definition**

Update `packages/server/src/db/schema.ts` with an `apiTokens` table:

```ts
export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  note: text("note").notNull(),
  createdAt: text("created_at").notNull(),
});
```

- [ ] **Step 4: Add the migration**

Update `packages/server/src/db/migrate.ts`:

```sql
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

- [ ] **Step 5: Re-run the focused test**

Run: `npm test -- test/server-integration.test.ts`

Expected: still FAIL, but now on missing route/handler rather than missing table.

### Task 2: Implement owner-only token management routes

**Files:**

- Create: `packages/server/src/routes/api-tokens.ts`
- Modify: `packages/server/src/app.ts`
- Test: `test/server-integration.test.ts`

- [ ] **Step 1: Write/extend failing assertions for response shapes**

Cover these exact payload expectations:

```ts
expect(createJson).toMatchObject({
  id: expect.stringMatching(/^sk-/),
  note: "Cursor local",
});

expect(listJson.items[0]).toMatchObject({
  id: createJson.id,
  tokenPrefix: `${createJson.id.slice(0, 6)}...`,
  note: "Cursor local",
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/server-integration.test.ts`

Expected: FAIL with 404 or shape mismatch.

- [ ] **Step 3: Implement the route file with minimal handlers**

Create `packages/server/src/routes/api-tokens.ts` with:

- `POST /` that validates `{ note: string }`, generates `sk-...`, inserts it, returns full `id`
- `GET /` that returns `id`, `note`, `createdAt`, `tokenPrefix`
- `DELETE /:id` that deletes by primary key and returns `204`

Return bodies that match the approved spec examples directly, not wrapped in `{ data: ... }`.

Keep helpers small and local, for example:

```ts
function buildTokenPrefix(id: string) {
  return `${id.slice(0, 6)}...`;
}
```

- [ ] **Step 4: Mount the route in `createApp`**

Wire `apiTokensRoutes` into `packages/server/src/app.ts` under:

```ts
app.route("/api/:pubKey/api-tokens", apiTokensRoutes({ connMgr }));
```

Follow existing owner-auth route patterns used by profile/anchor routes.

- [ ] **Step 5: Re-run the focused integration test**

Run: `npm test -- test/server-integration.test.ts`

Expected: PASS for token CRUD scenarios.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/db/schema.ts packages/server/src/db/migrate.ts packages/server/src/routes/api-tokens.ts packages/server/src/app.ts test/server-integration.test.ts
git commit -m "feat: add owner api token management"
```

## Chunk 2: Avatar Runtime And OpenAI Chat Adapter

### Task 3: Define a protocol-neutral avatar inference request/response layer

**Files:**

- Create: `packages/server/src/avatar/model.ts`
- Create: `packages/server/src/avatar/runtime.ts`
- Modify: `packages/server/src/llm/client.ts`
- Test: `packages/server/test/avatar-runtime.test.ts` or `test/avatar-openapi-integration.test.ts`

- [ ] **Step 1: Write a failing test for request normalization and augmentation order**

Cover a runtime-oriented case that proves the internal order is:

- platform segment
- avatar segment
- caller turns
- recall segment

Example assertion shape:

```ts
expect(messages.map((m) => m.content)).toEqual([
  expect.stringContaining("ReMi"),
  expect.stringContaining("avatar identity"),
  "caller message",
  expect.stringContaining("recalled anchors"),
]);
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- test/avatar-openapi-integration.test.ts`

Expected: FAIL because the runtime/model files do not exist yet.

- [ ] **Step 3: Create the neutral request/response types**

In `packages/server/src/avatar/model.ts`, define small focused types such as:

```ts
export interface AvatarInferenceRequest {
  avatarTarget: { publicKey: string };
  instructionSegments: {
    platform: string;
    avatar: string;
    recall: string;
  };
  conversationTurns: { role: "system" | "user" | "assistant"; content: string }[];
  contentParts: [];
  stream: boolean;
}
```

Also define a neutral output/event model that can later map to OpenAI JSON or SSE.

- [ ] **Step 4: Implement the minimal runtime skeleton**

Create `packages/server/src/avatar/runtime.ts` that:

- accepts a neutral request
- builds downstream chat messages in the cache-friendly order
- calls the existing `ChatClient`
- exposes either `run()` or `runStream()` based on the same internal augmentation path

At the same time, update `packages/server/src/llm/client.ts` so it no longer merges all `system` messages into the first `user` message. Preserve ordered downstream messages exactly, because the approved spec depends on the stable layer order for cache behavior.

- [ ] **Step 5: Re-run the focused test**

Run: `npm test -- test/avatar-openapi-integration.test.ts`

Expected: PASS for normalization/ordering expectations, or fail only on downstream route wiring not yet implemented.

### Task 4: Reuse recall and stable prompt building without coupling runtime to old route semantics

**Files:**

- Modify: `packages/server/src/reasoning/engine.ts` only if extracting helper code simplifies reuse
- Create: `packages/server/src/avatar/message-augmentation.ts`
- Modify: `packages/server/src/avatar/runtime.ts`
- Test: `test/avatar-openapi-integration.test.ts`

- [ ] **Step 1: Write a failing integration test for recall injection**

Add a case that seeds anchors, calls the new avatar runtime through the forthcoming route, and asserts the downstream chat client receives a final recall block that includes recalled anchor text.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- test/avatar-openapi-integration.test.ts`

Expected: FAIL because recall injection is not yet wired.

- [ ] **Step 3: Extract or implement minimal augmentation helpers**

Create `packages/server/src/avatar/message-augmentation.ts` with focused functions such as:

- `buildPlatformSegment()`
- `buildAvatarIdentitySegment(publicKey)`
- `buildRecallSegment(anchors)`
- `buildDownstreamMessages(...)`

Keep recall as a low-priority context segment encoded after caller messages.

- [ ] **Step 4: Wire recall into avatar runtime**

Use the existing recall/reasoning building blocks where practical:

- count anchors
- full injection vs recall runtime
- anchor formatting

Do not persist `/ai` calls into the old direct-message ledger unless explicitly chosen during implementation review; MVP only needs inference output.

- [ ] **Step 5: Re-run the focused integration test**

Run: `npm test -- test/avatar-openapi-integration.test.ts`

Expected: PASS for recall block presence and ordering.

### Task 5: Add `/ai/v1/chat/completions` route with OpenAI-style JSON and stream responses

**Files:**

- Create: `packages/server/src/routes/ai-chat-completions.ts`
- Modify: `packages/server/src/app.ts`
- Possibly modify: `packages/server/src/llm/client.ts`
- Test: `test/avatar-openapi-integration.test.ts`

- [ ] **Step 1: Write failing integration tests for non-stream and stream modes**

Cover at least these cases:

- valid bearer token + matching model returns `200`
- `stream: false` returns an OpenAI-style completion envelope
- `stream: true` returns SSE chunks and `[DONE]`
- invalid token returns `401 invalid_api_key`
- malformed `model` returns `400 invalid_model`
- parsed `model` pointing to a missing owner DB returns `404 model_not_found`
- unsupported extra field returns `400 unsupported_parameter`
- downstream chat client failure returns `502 upstream_model_error`

Minimal expected response examples:

```ts
expect(json.object).toBe("chat.completion");
expect(json.choices[0].message.role).toBe("assistant");
expect(typeof json.choices[0].message.content).toBe("string");
```

```ts
expect(text).toContain("data: ");
expect(text).toContain("[DONE]");
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- test/avatar-openapi-integration.test.ts`

Expected: FAIL because the route does not exist yet.

- [ ] **Step 3: Implement request validation and model parsing**

In `packages/server/src/routes/ai-chat-completions.ts`:

- validate body contains only `model`, `messages`, `stream`
- reject any extra keys with `400 unsupported_parameter`
- parse `ReMi-<pubKey>` before opening DB
- open the owner DB via `ConnectionManager`
- validate `Authorization: Bearer sk-xxxx` against `api_tokens.id`

- [ ] **Step 4: Implement OpenAI-style non-stream response adaptation**

Map runtime output into a minimal chat completion envelope:

```json
{
  "id": "chatcmpl_xxx",
  "object": "chat.completion",
  "created": 1710000000,
  "model": "ReMi-<pubKey>",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "..." },
      "finish_reason": "stop"
    }
  ]
}
```

- [ ] **Step 5: Implement OpenAI-style stream adaptation**

Emit SSE chunks shaped like `chat.completion.chunk` and terminate with `data: [DONE]`.

Use `packages/server/src/llm/client.ts` as a required compatibility touchpoint:

- preserve ordered system/user/assistant messages
- keep stream handling minimal
- avoid redesigning the whole client beyond what `/ai` needs

- [ ] **Step 6: Mount the route in `createApp`**

Add the new route under:

```ts
app.route(
  "/ai/v1/chat/completions",
  aiChatCompletionsRoute({ connMgr, chatClient, embeddingClient }),
);
```

- [ ] **Step 7: Re-run the focused integration test**

Run: `npm test -- test/avatar-openapi-integration.test.ts`

Expected: PASS for valid/invalid auth, model parsing, unsupported parameters, stream and non-stream paths.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/avatar packages/server/src/routes/ai-chat-completions.ts packages/server/src/app.ts packages/server/src/llm/client.ts test/avatar-openapi-integration.test.ts
git commit -m "feat: add avatar openai chat completions api"
```

## Chunk 3: Settings UI For Owner Token Management

### Task 6: Add web API helpers for owner token management

**Files:**

- Modify: `packages/web/src/lib/api-client.ts`
- Possibly create: `packages/web/src/lib/api-tokens.ts`
- Test: `test/server-integration.test.ts` remains server-side; add web unit coverage only if the repo already has a nearby pattern

- [ ] **Step 1: Write the smallest failing UI helper test only if an existing test pattern exists**

If there is no nearby web helper test pattern, skip adding a new isolated helper test and cover this behavior through end-to-end manual verification plus existing integration tests.

- [ ] **Step 2: Add typed helper methods**

Expose small helpers for:

- create token
- list tokens
- delete token

Either add them directly to `ApiClient` or create a thin wrapper in `packages/web/src/lib/api-tokens.ts`.

- [ ] **Step 3: Verify typecheck/test surface still passes**

Run: `npm test -- test/server-integration.test.ts`

Expected: PASS; no server contract drift.

### Task 7: Add token management UI to settings page

**Files:**

- Modify: `packages/web/src/pages/SettingsPage.tsx`
- Possibly reuse: existing card/button/input UI components

- [ ] **Step 1: Add a failing UI expectation only if the repo has a nearby page-level test harness**

If no existing page-level web test harness is already used in this repo, do not create a brand new frontend test stack for this MVP; rely on integration tests plus manual verification.

- [ ] **Step 2: Implement minimal state and loading flows in settings page**

Add UI for:

- listing existing token notes + token ids + created time
- entering a note and creating a token
- showing the created token value with the simplified `id = token` model
- deleting a token from the list

Keep the UX intentionally minimal and explicit: this is an owner settings utility, not a polished developer portal yet.

- [ ] **Step 3: Preserve current settings page responsibilities**

Do not mix token management into profile/avatar flows. Add a clearly separate section/card inside `SettingsPage.tsx`.

- [ ] **Step 4: Manually verify the UI against a running dev server**

Run:

```bash
npm run dev
```

Verify:

- create token returns the full `sk-...` value and the settings view may show it again later
- refresh still keeps enough token info for the owner to identify the token entry
- delete removes token immediately

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/pages/SettingsPage.tsx packages/web/src/lib/api-client.ts packages/web/src/lib/api-tokens.ts
git commit -m "feat: add api token settings ui"
```

## Chunk 4: Verification And Cleanup

### Task 8: Run end-to-end verification for the MVP slice

**Files:**

- Modify only if verification uncovers issues
- Test: `test/server-integration.test.ts`
- Test: `test/avatar-openapi-integration.test.ts`

- [ ] **Step 1: Run focused integration tests**

Run:

```bash
npm test -- test/server-integration.test.ts test/avatar-openapi-integration.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Fix any failures with the smallest scoped change**

If failures appear, add/adjust the narrowest missing validation or response-shape code rather than redesigning the runtime late in the process.

- [ ] **Step 4: Re-run the full suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Optional manual curl smoke test**

After creating a token in the UI or directly in the DB during development, verify:

```bash
curl "$BASE_URL/ai/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ReMi-'"$PUBKEY"'",
    "messages": [{"role": "user", "content": "给我一个今天的工作建议"}],
    "stream": false
  }'
```

Expected: valid OpenAI-style chat completion JSON.

- [ ] **Step 6: Final commit**

```bash
git add packages/server packages/web test
git commit -m "feat: add self-serve avatar openapi mvp"
```
