# 私聊消息单表账本 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用单表 `direct_messages` 替换现有 `reasoning_messages`，实现私聊双库强一致写入、密文落库、链式完整性与后台 attestation。

**Architecture:** 服务端以 `party_a_key/party_b_key` 稳定槽位为中心，生成 canonical fact、`message_hash`、`prev_message_hash`，再派生 `ciphertext_a/b/c` 并双写到双方数据库。读取侧不再按 owner 库里的 `visitor_key` 查询旧表，而是从当前用户自己的数据库按对手 key 聚合 `direct_messages`；回执更新采用准实时复制并可恢复收敛。

**Tech Stack:** TypeScript, Hono, drizzle-orm, better-sqlite3, Web Crypto / Node crypto, sqlite-vec, vitest, React

**Spec:** `docs/superpowers/specs/2026-03-22-conversation-ledger-design.md`

**API Compatibility:** 本期保留现有 `/reasoning/...` 与 `/conversations` 外部接口，只替换底层存储与 payload 形态；不在本计划里重命名公开路由为 `/direct-messages/...`。

---

## 文件结构

```text
packages/server/src/
├── db/
│   ├── migrate.ts                        # 修改：删除 reasoning_messages，创建 direct_messages
│   └── schema.ts                         # 修改：定义 direct_messages schema
├── messaging/
│   ├── slots.ts                          # 新增：party_a/party_b 排序与槽位映射
│   ├── body.ts                           # 新增：body_json 类型、canonical serialization
│   ├── crypto.ts                         # 新增：AES-256-GCM + sealed box envelope helpers
│   ├── ledger.ts                         # 新增：canonical fact、hash、prev hash、receipt patch helpers
│   └── types.ts                          # 新增：shared types for direct messages
├── routes/
│   ├── reasoning.ts                      # 大改：切到 direct_messages 路由/双写/查询模型
│   └── conversations.ts                  # 修改：消息列表改为 direct_messages 聚合
├── reasoning/
│   └── engine.ts                         # 修改：适配新消息存储与 done payload

packages/server/test/
├── db/
│   └── migrate.test.ts                   # 修改：校验 direct_messages schema
├── messaging/
│   ├── slots.test.ts                     # 新增：槽位排序与 self/peer 映射
│   ├── body.test.ts                      # 新增：canonical body serialization
│   ├── crypto.test.ts                    # 新增：envelope encode/decode、tamper 检测
│   └── ledger.test.ts                    # 新增：message_hash、prev_message_hash、receipt patch
├── routes/
│   ├── reasoning.test.ts                 # 大改：direct_messages CRUD / dual-write / receipts
│   └── conversations.test.ts             # 新增：列表与 contacts 聚合走新表

test/
├── reasoning-integration.test.ts         # 大改：真实签名、双库落库、列表与消息读取

packages/web/src/
├── pages/
│   ├── AvatarChatPage.tsx                # 修改：切换到新 API 与 body_json 发送
│   └── MessagesPage.tsx                  # 修改：消费新会话列表形态
└── hooks/
    └── use-chat.ts                       # 视需要修改：支持新消息字段映射
```

## Chunk 1: Schema + Protocol Helpers

### Task 1: 先把 `direct_messages` schema 定死

**Files:**

- Modify: `packages/server/src/db/migrate.ts`
- Modify: `packages/server/src/db/schema.ts`
- Modify: `packages/server/test/db/migrate.test.ts`

- [ ] **Step 1: 写失败测试，定义新表必须存在**

在 `packages/server/test/db/migrate.test.ts` 增加断言：数据库初始化后包含 `direct_messages`，且不再要求 `reasoning_messages` 存在。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/server/test/db/migrate.test.ts`
Expected: FAIL，缺少 `direct_messages`

- [ ] **Step 3: 在 migrate 中创建 `direct_messages`**

表字段按 spec 固定为：

```ts
(shared_message_id,
  party_a_key,
  party_b_key,
  sender_key,
  sender_kind,
  ciphertext_a,
  ciphertext_b,
  ciphertext_c,
  message_hash,
  prev_message_hash,
  created_at,
  delivered_at_a,
  delivered_at_b,
  read_at_a,
  read_at_b,
  attested_at_a,
  attested_at_b,
  sign_a,
  sign_b,
  status_reason_a,
  status_reason_b);
```

- [ ] **Step 4: 在 schema 中导出 `directMessages` drizzle table**

保持现有 `camelCase <-> snake_case` 风格，例如：`sharedMessageId: text("shared_message_id")`。

- [ ] **Step 5: 删除旧 `reasoningMessages` schema 与 migrate 路径**

只删除 reasoning 消息表，不动 `messages`、`memories`、`soul_anchors`。

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run packages/server/test/db/migrate.test.ts`
Expected: PASS

### Task 2: 把 A/B 槽位排序与 body canonicalization 单独抽出来

**Files:**

- Create: `packages/server/src/messaging/slots.ts`
- Create: `packages/server/src/messaging/body.ts`
- Create: `packages/server/src/messaging/types.ts`
- Create: `packages/server/test/messaging/slots.test.ts`
- Create: `packages/server/test/messaging/body.test.ts`

- [ ] **Step 1: 写失败测试，要求 pubkey 排序稳定**

在 `slots.test.ts` 里覆盖：

- 输入 `(b, a)` 仍输出 `party_a_key=a, party_b_key=b`
- 同 key 输入时报错
- 已排序输入保持不变

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/server/test/messaging/slots.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现最小槽位 helper**

导出：

```ts
sortPartyKeys(a: string, b: string)
getPartySlot(parties, key)
```

- [ ] **Step 4: 写失败测试，要求 body_json canonical serialization 稳定**

在 `body.test.ts` 里断言：

- 同语义 JSON 不同 key 顺序时输出相同字符串
- 缺少 `type` / `version` 时报错
- 未识别 `type` 仍可 canonicalize

- [ ] **Step 5: 运行 body 测试确认失败**

Run: `npx vitest run packages/server/test/messaging/body.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 6: 实现最小 body helper**

导出：

```ts
canonicalizeBodyJson(input: unknown): string
```

只做 spec 里要求的校验：`type`、`version`、稳定 key 排序。

- [ ] **Step 7: 运行两组测试确认通过**

Run: `npx vitest run packages/server/test/messaging/slots.test.ts packages/server/test/messaging/body.test.ts`
Expected: PASS

### Task 3: 把 canonical fact、hash、receipt patch 做成纯函数

**Files:**

- Create: `packages/server/src/messaging/ledger.ts`
- Create: `packages/server/test/messaging/ledger.test.ts`

- [ ] **Step 1: 写失败测试，要求 canonical fact hash 稳定**

断言同一输入必然生成同一 `message_hash`，且字段顺序变化不影响结果。

- [ ] **Step 2: 写失败测试，要求 receipt patch 只更新对应槽位**

覆盖：

- `read_at_a` 只改 A 槽
- `sign_b` 只改 B 槽

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run packages/server/test/messaging/ledger.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 4: 实现最小 ledger helper**

导出：

```ts
buildCanonicalFact(...)
computeMessageHash(...)
applyReceiptPatch(...)
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run packages/server/test/messaging/ledger.test.ts`
Expected: PASS

### Task 4: 把加密 envelope 单独做透

**Files:**

- Create: `packages/server/src/messaging/crypto.ts`
- Create: `packages/server/test/messaging/crypto.test.ts`

- [ ] **Step 1: 写失败测试，要求 envelope 可编码 / 解码**

覆盖：

- `ciphertext_*` 使用 `base64`
- `version + wrapped_key_length + wrapped_key + iv + ciphertext_body + tag` 顺序正确

- [ ] **Step 2: 写失败测试，要求 tamper 会导致认证失败**

篡改密文 body 或 tag 后，断言解密抛错。

- [ ] **Step 3: 写失败测试，要求每条消息使用新 AES key 和新 IV**

相同明文加密两次，断言 envelope 不同。

- [ ] **Step 4: 运行测试确认失败**

Run: `npx vitest run packages/server/test/messaging/crypto.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 5: 实现最小 crypto helper**

导出：

```ts
encryptBodyForRecipient(...)
decryptBodyEnvelope(...)
encodeCiphertextEnvelope(...)
decodeCiphertextEnvelope(...)
```

要求：

- AES-256-GCM
- 96-bit IV
- sealed-box 风格 wrapped key（实现可先用测试替身或明确 TODO-free adapter）
- 返回 base64 envelope

- [ ] **Step 6: 运行加密测试确认通过**

Run: `npx vitest run packages/server/test/messaging/crypto.test.ts`
Expected: PASS

## Chunk 2: Server Storage, Routes, and Integration

### Task 5: 先改 conversation list，不再依赖旧 reasoning 表

**Files:**

- Modify: `packages/server/src/routes/conversations.ts`
- Create: `packages/server/test/routes/conversations.test.ts`

- [ ] **Step 1: 写失败测试，要求会话列表与 contacts 都按 `direct_messages` 聚合**

断言：

- `GET /:pubKey/conversations` 能看到私聊对象与最新消息预览
- `GET /:pubKey/contacts` 不再读 `reasoning_messages`

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/server/test/routes/conversations.test.ts`
Expected: FAIL，仍读取旧表

- [ ] **Step 3: 修改列表与 contacts 查询**

把 avatar conversation 与 contacts 的来源都改为 `direct_messages` 最新记录聚合。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/server/test/routes/conversations.test.ts`
Expected: PASS

### Task 6: 重写 `/reasoning/messages` 的读取 API

**Files:**

- Modify: `packages/server/src/routes/reasoning.ts`
- Modify: `packages/server/test/routes/reasoning.test.ts`
- Modify: `test/reasoning-integration.test.ts`

- [ ] **Step 1: 写失败测试，要求 GET 读取 `direct_messages` 而不是 `reasoning_messages`**

断言：

- 路由按当前 signer 与 `:pubKey` 形成稳定 `(party_a_key, party_b_key)`
- 外部接口路径仍为 `/reasoning/messages`
- 返回字段改为新消息结构
- 不泄漏 `ciphertext_c`

- [ ] **Step 2: 写失败测试，要求 UI 侧读取到 self/peer 视图可派生的数据**

至少断言返回中包含：

- `sender_key`
- `sender_kind`
- `created_at`

- [ ] **Step 3: 运行 route 测试确认失败**

Run: `npx vitest run packages/server/test/routes/reasoning.test.ts test/reasoning-integration.test.ts`
Expected: FAIL

- [ ] **Step 4: 修改 GET /reasoning/messages 查询**

读取当前库中的 `direct_messages`，按 `(party_a_key, party_b_key)` 过滤和分页。

- [ ] **Step 5: 映射响应 payload**

最小响应需要包含：

- `shared_message_id`
- `sender_key`
- `sender_kind`
- 当前用户可读的解密后 body 或兼容 chat view 的最小文本映射
- `created_at`
- read / attestation 相关状态（如果前端会立刻用到）

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run packages/server/test/routes/reasoning.test.ts test/reasoning-integration.test.ts`
Expected: GET 相关 PASS

### Task 7: 重写 POST /reasoning/message 为双库 ledger 写入

**Files:**

- Modify: `packages/server/src/routes/reasoning.ts`
- Modify: `packages/server/src/reasoning/engine.ts`
- Modify: `packages/server/test/routes/reasoning.test.ts`
- Modify: `test/reasoning-integration.test.ts`

- [ ] **Step 1: 写失败测试，要求 route 层先正确构造 canonical fact**

断言提交一条消息后，落库行包含：

- 排序后的 `party_a_key / party_b_key`
- `sender_key`
- `message_hash`
- `prev_message_hash`

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/server/test/routes/reasoning.test.ts test/reasoning-integration.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现最小 fact 构造与 SSE done payload 适配**

先只让 route 能构造新 fact，并让 `done` payload 不再依赖旧 `reasoning_messages.id` 语义。

- [ ] **Step 4: 运行测试确认只有 fact / done 相关通过**

Run: `npx vitest run packages/server/test/routes/reasoning.test.ts test/reasoning-integration.test.ts`
Expected: fact / done 相关 PASS，其余双写相关 FAIL

- [ ] **Step 5: 写失败测试，要求发送消息双写双方数据库**

断言 owner 与 visitor 两个库中都出现相同：

- `shared_message_id`
- `message_hash`
- `prev_message_hash`

- [ ] **Step 6: 写失败测试，要求单边失败时整体失败并回滚**

通过 stub 第二个库写入失败，断言第一个库不留下残留消息。

- [ ] **Step 7: 运行测试确认失败集中在双写/回滚**

Run: `npx vitest run packages/server/test/routes/reasoning.test.ts test/reasoning-integration.test.ts`
Expected: FAIL，集中在双写/回滚

- [ ] **Step 8: 实现双写与回滚**

流程固定为：

1. 排序 `party_a_key/party_b_key`
2. 生成 canonical fact
3. 生成 `message_hash`
4. 生成 `ciphertext_a/b/c`
5. 双写双方库
6. 失败时回滚
7. 更新 `delivered_at_a/b`

- [ ] **Step 9: 写失败测试，要求同线程消息串行分配 `prev_message_hash`**

构造两条顺序消息，断言后一条引用前一条 hash。

- [ ] **Step 10: 实现线程串行化**

在 route/service 层引入按 `(party_a_key, party_b_key)` 锁定的最小串行化机制。

- [ ] **Step 11: 让 ReasoningEngine 只负责 LLM/recall，不再直接保存旧表消息**

必要时把 message persistence 下沉到 route/service helper，避免 engine 继续绑旧 `role/content` 模型。

- [ ] **Step 12: 运行测试确认通过**

Run: `npx vitest run packages/server/test/routes/reasoning.test.ts test/reasoning-integration.test.ts`
Expected: POST 相关 PASS

### Task 8: 增加 read / attest 更新与完整性查询

**Files:**

- Modify: `packages/server/src/routes/reasoning.ts`
- Modify: `packages/server/test/routes/reasoning.test.ts`
- Modify: `test/reasoning-integration.test.ts`

- [ ] **Step 1: 写失败测试，要求 read 更新复制到双方数据库**

断言某一方上报 read 后，双方库对应槽位的 `read_at_*` 一致。

- [ ] **Step 2: 写失败测试，要求 attest 写入 `sign_*` 且使用 base58**

断言：

- 对应槽位的 `attested_at_*` 与 `sign_*` 被更新
- `sign_*` 符合 base58 字符集

- [ ] **Step 3: 写失败测试，要求 read/attest 复制失败进入可恢复收敛路径**

断言：

- 原始消息 fact 保持不变
- 失败的 receipt patch 被记录为待重试状态

- [ ] **Step 4: 写失败测试，要求 GET 展示以“较新且校验一致”的回执值为准**

构造双方副本 receipt 漂移，断言读取层按 spec 规则选取展示值。

- [ ] **Step 5: 写失败测试，要求 integrity API 能报告 hash 冲突与 tag 失败**

最小断言：

- 正常链返回 healthy
- 篡改副本返回 conflicted / tampered

- [ ] **Step 6: 写失败测试，要求 rollback 失败后线程进入禁发状态**

断言：

- 后续 POST 被拒绝
- integrity 或错误响应能反映 blocked 状态

- [ ] **Step 7: 运行测试确认失败**

Run: `npx vitest run packages/server/test/routes/reasoning.test.ts test/reasoning-integration.test.ts`
Expected: FAIL

- [ ] **Step 8: 实现 read / attest 路由**

要求：

- read 更新复制双方副本
- attest 验证 Ed25519 签名
- 失败进入 retry / reason 字段，不污染原始 fact

- [ ] **Step 9: 实现 receipt 收敛读取规则与 retry hook**

最小可行实现即可，但必须让测试能验证“较新且校验一致者为准”。

- [ ] **Step 10: 实现 rollback failure blocked 行为与 repair 标记**

不要求完整 repair daemon，只要：

- blocked 状态可落库/可推导
- 后续发送会被拒绝
- repair job 有明确入口或 stub

- [ ] **Step 11: 实现最小 integrity 路由**

返回：

- 当前链健康状态
- 是否有 `message_hash` 冲突
- 是否有密文认证失败

- 是否处于 blocked 状态

- [ ] **Step 12: 运行测试确认通过**

Run: `npx vitest run packages/server/test/routes/reasoning.test.ts test/reasoning-integration.test.ts`
Expected: PASS

## Chunk 3: Web Wiring, Cleanup, and Full Verification

### Task 9: 调整前端页面接入新 API 与新消息模型

**Files:**

- Modify: `packages/web/src/pages/AvatarChatPage.tsx`
- Modify: `packages/web/src/pages/MessagesPage.tsx`
- Modify: `packages/web/test/hooks/use-chat.test.ts`
- Modify: `packages/web/src/hooks/use-chat.ts`

- [ ] **Step 1: 在 `packages/web/test/hooks/use-chat.test.ts` 写失败测试，要求聊天页改用新 direct message payload**

在现有 hook 测试里断言：

- 读取返回的新字段能映射成 chat message
- 发送请求 body 改为 `body_json`

- [ ] **Step 2: 运行前端相关测试确认失败**

Run: `npx vitest run packages/web/test/hooks/use-chat.test.ts`
Expected: FAIL

- [ ] **Step 3: 修改 AvatarChatPage 的 load/send 路径与 body_json 提交**

发送 payload 至少改成：

```json
{ "body_json": { "type": "text", "version": 1, "text": "...", "entities": [] } }
```

- [ ] **Step 4: 修改 MessagesPage 以消费 direct_messages 聚合后的预览**

保持现有 UI 风格，只改数据来源与字段映射。

- [ ] **Step 5: 运行前端测试确认通过**

Run: `npx vitest run packages/web/test/hooks/use-chat.test.ts`
Expected: PASS

### Task 10: 删除旧 reasoning_messages 依赖并补全回归

**Files:**

- Modify: `packages/server/src/routes/reasoning.ts`
- Modify: `packages/server/src/db/migrate.ts`
- Modify: `packages/server/src/db/schema.ts`
- Modify/Delete: any tests still seeding `reasoning_messages`

- [ ] **Step 1: 把所有测试 seed helper 改到 `direct_messages`**

重点更新：

- `test/reasoning-integration.test.ts`
- `packages/server/test/routes/reasoning.test.ts`
- `packages/server/test/routes/conversations.test.ts`

- [ ] **Step 2: 运行 reasoning 相关测试集**

Run: `npx vitest run packages/server/test/db/migrate.test.ts packages/server/test/routes/conversations.test.ts packages/server/test/routes/reasoning.test.ts packages/server/test/messaging/slots.test.ts packages/server/test/messaging/body.test.ts packages/server/test/messaging/ledger.test.ts packages/server/test/messaging/crypto.test.ts test/reasoning-integration.test.ts`
Expected: PASS

- [ ] **Step 3: 跑全量测试集**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: 跑 lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db/migrate.ts packages/server/src/db/schema.ts packages/server/src/messaging packages/server/src/routes/reasoning.ts packages/server/src/routes/conversations.ts packages/server/src/reasoning/engine.ts packages/server/test/db/migrate.test.ts packages/server/test/messaging packages/server/test/routes/reasoning.test.ts packages/server/test/routes/conversations.test.ts test/reasoning-integration.test.ts packages/web/src/pages/AvatarChatPage.tsx packages/web/src/pages/MessagesPage.tsx packages/web/src/hooks/use-chat.ts packages/web/test/hooks/use-chat.test.ts docs/superpowers/specs/2026-03-22-conversation-ledger-design.md docs/superpowers/plans/2026-03-22-direct-message-ledger.md
git commit -m "refactor(server): replace reasoning messages with direct message ledger"
```
