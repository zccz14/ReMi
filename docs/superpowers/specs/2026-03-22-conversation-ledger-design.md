# 私聊消息单表账本设计

## 概述

当前 `reasoning_messages` 的问题已经很明确：

- 消息只落在 owner 的数据库，访客自己拿不到完整记录
- `role=user|assistant` 无法表达私聊里的四角色视图
- 消息缺少可验证的事实链、签名确认与篡改检测
- 纯文本正文不利于扩展富消息

本设计收敛为一个**只处理私聊**的单表账本模型：

- 只支持一对一私聊
- 永远不兼容群聊
- 未来群聊使用完全独立的表与协议
- 即便 UI 上出现“私聊转群聊”，底层也必须新建群聊对象，而不是复用本表

## 目标

- 用新的私聊单表账本替换现有 `reasoning_messages`
- 每条私聊消息在发送成功时必须同时写入双方数据库
- 只有双方都写入成功，才返回发送成功
- 一条消息同时承载：消息事实、双方密文副本、双方 read/attest 状态
- 消息正文使用可扩展 JSON 协议
- 引入 canonical fact、`message_hash`、`prev_message_hash`
- 默认 UI 只展示 delivered / read；attestation 在后台自动完成
- 数据库存密文，但平台保留可读副本以支持 AI 分身

## 非目标

- 不改造 interview 的 `messages` 表
- 不支持群聊、群主、成员管理、转群、邀请等能力
- 不追求平台不可见的严格 E2EE
- 不做法律导出、公证对接等后续能力

## 范围硬约束

- 本表只表示一对一私聊消息
- 一行只对应一条私聊消息事实
- 一条消息只允许恰好两个真实参与者：`party_a` 与 `party_b`
- `party_a` 与 `party_b` 必须互异，不允许自己给自己发私聊
- 群聊永远不在本表上扩展字段或打补丁

## 核心原则

### 0. 命名与编码约定

本设计中的数据库字段统一采用 `snake_case`。

槽位标记统一放在后缀：

- `_a` = `party_a`
- `_b` = `party_b`
- `_c` = platform

编码约定：

- `ciphertext_*` 使用 `base64`
- `sign_*` 使用 `base58`
- `message_hash` / `prev_message_hash` 使用 hex string

### 1. 单表，但仍区分事实与确认语义

虽然只用一张表，但逻辑上仍分两层：

- **fact**：消息本身是什么，链头是什么，hash 是什么
- **receipt/attestation**：双方何时送达、已读、已确认

只是这两层都收纳在同一行里，而不是拆表。

### 2. 私聊槽位固定，不做 participant 抽象

因为只做私聊，所以不再引入 `conversation_participants`、`conversations`、`message_receipts` 等表。

取而代之的是固定两个槽位：

- `party_a_key`
- `party_b_key`

所有 `..._a` / `..._b` 字段都严格对应槽位，而不是对应发送方/接收方。

### 3. 槽位顺序必须稳定

为了避免同一对用户在不同设备/不同请求里出现 A/B 翻转，`party_a_key` 与 `party_b_key` 必须按固定规则排序后再落库，推荐：

- 字典序较小者为 `party_a_key`
- 字典序较大者为 `party_b_key`

之后所有槽位字段都以此排序结果解释。

这是底层协议约束，不是 UI 视角约束。

- `party_a_key / party_b_key` 是稳定槽位
- `self / peer` 只是当前登录用户视角下的渲染结果

因此：

- canonical fact 必须使用排序后的 `party_a_key / party_b_key`
- 双写到双方数据库时，不允许因为“当前是谁在看”而翻转 A/B
- `read_at_a/read_at_b`、`attested_at_a/attested_at_b`、`ciphertext_a/ciphertext_b` 都严格绑定槽位，而不是绑定 self/peer

### 4. 四角色只在 UI 视图中派生

底层只存：

- `sender_key`
- `sender_kind = owner | avatar`

UI 再根据当前登录用户和 `party_a_key/party_b_key` 派生出：

- 我方本体
- 我方分身
- 对方本体
- 对方分身

映射规则：

- 若当前登录用户公钥等于 `party_a_key`，则 `A = self`、`B = peer`
- 若当前登录用户公钥等于 `party_b_key`，则 `B = self`、`A = peer`

这个映射只存在于读取与渲染层，不能反向污染底层存储协议。

## 单表设计

表名建议：`direct_messages`

```ts
{
  id: number,
  shared_message_id: string,
  party_a_key: string,
  party_b_key: string,
  sender_key: string,
  sender_kind: "owner" | "avatar",

  ciphertext_a: string,
  ciphertext_b: string,
  ciphertext_c: string,

  message_hash: string,
  prev_message_hash: string | null,
  created_at: number,

  delivered_at_a: number | null,
  delivered_at_b: number | null,
  read_at_a: number | null,
  read_at_b: number | null,
  attested_at_a: number | null,
  attested_at_b: number | null,
  sign_a: string | null,
  sign_b: string | null,
  status_reason_a: string | null,
  status_reason_b: string | null,
}
```

## 字段语义

### 参与者字段

- `party_a_key` / `party_b_key`
  - 这条私聊所属的两个真实参与者
  - 必须按固定排序落库
  - 推荐规则：按 pubkey 字典序排序，较小者放 A，较大者放 B

- `sender_key`
  - 当前消息是谁发送的，必须等于 `party_a_key` 或 `party_b_key`

- `sender_kind`
  - `owner | avatar`
  - 表示这条消息是以本体还是分身身份发出的

### 密文字段

- `ciphertext_a`
  - 给 `party_a_key` 读取的密文副本，`base64`

- `ciphertext_b`
  - 给 `party_b_key` 读取的密文副本，`base64`

- `ciphertext_c`
  - 给平台自身使用的可解密副本或平台密钥保护副本，`base64`

约束：

- 三份密文允许不同
- 但必须都对应同一个 canonical fact
- participant 数据库不持久化明文 `body_json`

### 事实链字段

- `shared_message_id`
  - 双方数据库中这条逻辑消息的共同 id

- `message_hash`
  - canonical fact 的 hash

- `prev_message_hash`
  - 该私聊上一条已成功提交 fact 的 `message_hash`
  - 这里是 fact chain，不是 attestation chain

- `created_at`
  - 服务端确认的消息时间

### 双方状态字段

这些字段都严格对应槽位，不对应发送方/接收方：

- `delivered_at_a` / `delivered_at_b`
- `read_at_a` / `read_at_b`
- `attested_at_a` / `attested_at_b`
- `sign_a` / `sign_b`
- `status_reason_a` / `status_reason_b`

例如：

- 若 `party_a_key` 是当前消息发送者，则发送成功后 `delivered_at_a` 立即可写
- 若 `party_b_key` 读取后自动 attest，则更新的是 `read_at_b`、`attested_at_b`、`sign_b`

## 消息体协议

消息正文使用规范化 JSON，但不以明文字段落库。

最小示例：

```json
{
  "type": "text",
  "version": 1,
  "text": "你好",
  "entities": []
}
```

扩展示例：

- `mention`
- `link`
- `red_packet`
- `image`
- `system_notice`

要求：

- 每条消息必须有 `type`
- 每种 `type` 必须有 `version`
- `body_json` 必须参与 canonical fact 生成与 `message_hash` 计算
- 未识别类型也必须可保留、可验签、可降级渲染

### 加密封装协议

消息体加密采用“随机对称密钥 + 公钥封装密钥”的混合加密模式。

流程：

1. 将 `body_json` 序列化为 JSON 字符串
2. 用 `TextEncoder` 将该字符串编码为 `Uint8Array`
3. 为当前消息随机生成一个固定长度的 AES-256-GCM 对称密钥
4. 为本次加密随机生成 IV
5. 使用该对称密钥与 96-bit IV 对明文 `Uint8Array` 做 AES-256-GCM 加密，得到密文主体与认证标签
6. 使用阅读方的 Curve25519/X25519 加密公钥，以 sealed box 方式封装这个对称密钥，得到 `wrapped_key`
7. 将 `version + wrapped_key + iv + ciphertext_body + tag` 按固定顺序拼接封装成最终 `ciphertext_*`

因此：

- `ciphertext_a` 使用 `party_a_key` 对应的公钥封装对称密钥
- `ciphertext_b` 使用 `party_b_key` 对应的公钥封装对称密钥
- `ciphertext_c` 使用平台公钥封装对称密钥

最终封装后的二进制结果统一使用 `base64` 存储。

加密公钥来源规则：

- participant 的签名主公钥仍为 Ed25519，用于 `sign_a` / `sign_b`
- participant 的消息加密公钥通过既定的 Ed25519 -> Curve25519 转换规则派生
- 平台侧 `ciphertext_c` 使用平台自己的 Curve25519/X25519 加密公钥

因此本设计中：

- 签名密钥类型 = Ed25519
- 消息密钥封装公钥类型 = Curve25519/X25519 sealed box

### `ciphertext_*` 线格式

`ciphertext_*` 的封装格式必须固定，避免不同实现各自发明 envelope：

```text
version(1 byte)
wrapped_key_length(2 bytes, big-endian)
wrapped_key(variable)
iv(12 bytes)
ciphertext_body(variable)
tag(16 bytes)
```

定义：

- `version`：当前固定为 `0x01`
- `wrapped_key`：使用 sealed box 方式对 32-byte AES key 的封装结果
- `iv`：AES-256-GCM 的 96-bit 随机 IV
- `ciphertext_body`：AES-256-GCM 输出的正文密文，不含 tag
- `tag`：AES-256-GCM 的 128-bit 认证标签

其中 `wrapped_key` 的规范要求：

- 使用 reading target 的 Curve25519/X25519 加密公钥
- 使用 sealed box 语义，即封装结果内部自带发送方临时公钥能力
- 实现上可直接采用 libsodium sealed box / crypto_box_seal 的等价协议
- 不允许改成普通裸 X25519 shared secret 而不定义临时公钥与 KDF

因此：

- AES key 的封装协议是完整的、可互操作的 sealed box 协议
- `ciphertext_*` 的 envelope 顺序是固定的，不允许实现方自由发挥

这个设计的目的：

- 保留接近对称加密的正文加密效率
- 让每条消息都拥有独立的随机对称密钥，避免一条密文被破解后拖出整段历史
- 通过“每条消息独立密钥”尽量增强前向安全性

仍需明确接受的限制：

- 如果私钥与数据库同时泄漏，历史消息仍可能整体泄漏
- 这是当前平台可读、私钥体系与存储模型下无法彻底避免的风险

## Canonical Fact

服务端在写入前，先生成唯一 canonical fact：

```ts
{
  shared_message_id,
  party_a_key,
  party_b_key,
  sender_key,
  sender_kind,
  body_json,
  created_at,
  prev_message_hash,
}
```

然后：

1. 做稳定序列化
2. 计算 `message_hash`
3. 生成 `ciphertext_a`
4. 生成 `ciphertext_b`
5. 生成 `ciphertext_c`
6. 双写到双方数据库

### 规范化与算法约束

- canonical serialization：递归 key 排序的稳定 JSON 序列化
- 字符串编码：UTF-8
- 时间字段：Unix epoch milliseconds，十进制整数
- hash 算法：SHA-256，输出 hex string
- attestation 签名算法：Ed25519
- 签名输入固定为 `hexToBytes(message_hash)`
- 消息体对称加密算法：AES-256-GCM
- 消息密钥封装算法：X25519 sealed box（由 Ed25519 公钥转换得到阅读方加密公钥）

不允许：

- 依赖默认 JSON 字段顺序
- 对同一 payload 用不同数字格式
- 对 canonical fact 再二次 hash 后签名

### Attestation 信任模型

- 每个 participant 使用自己的 Ed25519 私钥对 `hexToBytes(message_hash)` 签名
- 服务端通过该 participant 的已知公钥验证签名
- participant 公钥来源沿用现有身份体系中的 pubkey，不额外引入独立 attestation identity
- 若未来发生密钥轮换，需要单独设计轮换协议；本期先假定 participant pubkey 稳定不变

## 强一致双写协议

### 发送成功定义

只有当双方数据库都成功写入同一个 fact 时，才返回发送成功。

### 线程串行化规则

同一私聊线程上的消息提交必须串行化，避免两条并发消息引用同一个 `prev_message_hash`。

约束：

- 线程键由排序后的 `(party_a_key, party_b_key)` 唯一确定
- `MessageFactCoordinator` 必须对同一线程加互斥锁或等价串行化机制
- 只有当前一条消息完成双写提交后，下一条消息才能读取新的链头并分配 `prev_message_hash`
- 因此，同一线程内不存在两个成功提交消息共享同一个前驱的合法状态

### 失败处理

任一侧写入失败时：

1. 先重试
2. 若仍失败，则回滚已成功写入的一侧
3. 最终对客户端返回失败

不允许：

- 只有一边成功却显示发送成功
- 先本地成功，另一边 eventual sync

### 回滚失败

若回滚也失败，则进入严重故障状态：

- 该私聊线程临时禁发
- 前端显示“会话修复中”
- repair job 对双方数据库按 `shared_message_id` 与 `message_hash` 对账
- 未修复前不允许继续发消息

### 回执更新一致性

`read_at_*`、`attested_at_*`、`sign_*`、`status_reason_*` 虽然不是消息创建 fact，但仍需要双边一致可见。

规则：

- 某一方客户端上报 read / attest 后，服务端必须把对应槽位更新复制到双方数据库
- 复制失败时，不回滚原始消息 fact，但该回执更新进入重试队列
- `GET` 类接口对外展示的 read / attest 状态以“双方副本中较新且校验一致的那份回执值”为准
- repair job 除了修 fact 层故障，也需要补齐回执类字段的副本漂移

因此：

- 消息创建是强一致提交
- 回执更新是准实时复制 + 可恢复收敛

## 已读与 Attestation

### 产品原则

- 用户默认只感知 delivered / read
- attestation 默认后台自动完成
- 不应要求用户频繁手动确认

### 默认推进规则

- 发送成功后，双方槽位同时写入各自的 `delivered_at`
- 发送方客户端完成本地渲染后即可写入 `read_at`
- 接收方打开消息后写入对应槽位的 `read_at`
- 任一方 read 后，客户端后台自动尝试 attestation
- 成功后写入对应槽位的 `attested_at` 与 `sign_*`

这里的语义固定为：

- `delivered_at` = 该消息 fact 已成功进入该参与者数据库
- `read_at` = 该参与者客户端已实际读取该消息
- `attested_at` = 该参与者已对 `message_hash` 完成签名确认

### 异常才升级提示

只有以下情况才显式打扰用户：

- 本地链校验失败
- 同一 `shared_message_id` 对应不同 `message_hash`
- 长时间无法完成 attestation
- 用户主动查看证据链

## 加密模型

### 安全目标

- 平台运行 AI 分身时可以读取明文
- 第三方即使拿到数据库，也不能直接读取消息内容
- 一致性校验基于 canonical fact，而不是基于密文本身

### 落库方式

用户发给平台的是明文请求。平台确认 canonical fact 后：

- 为 `party_a` 生成 `ciphertext_a`
- 为 `party_b` 生成 `ciphertext_b`
- 为平台生成 `ciphertext_c`

participant 数据库长期只保留密文副本和事实字段，不保留明文 `body_json`。

### 密文完整性

为了让“密文被篡改”可检测，密文格式必须固定使用带认证的加密方案 AES-256-GCM。

要求：

- `ciphertext_a`、`ciphertext_b`、`ciphertext_c` 都必须包含认证标签
- 解密时若认证标签校验失败，视为密文完整性损坏
- 密文完整性校验失败应上报给 `IntegrityChecker`

因此：

- `message_hash` 负责验证 canonical fact 是否一致
- AEAD 认证标签负责验证某份密文副本是否被改写

## 查询模型

### 会话列表

不单独建 conversation 表。私聊列表直接从 `direct_messages` 聚合得到：

- 用 `(party_a_key, party_b_key)` 识别一条私聊线程
- 取该线程最新一条消息作为列表预览

### 消息流

按 `(party_a_key, party_b_key)` 和 `created_at/id` 拉取消息流。

### 线程识别

因为 `party_a_key/party_b_key` 有稳定排序，所以同一对用户只会落入同一条私聊线程。

## API 调整建议

- `GET /direct-messages`
  - 返回当前用户的私聊列表（由消息聚合）
- `GET /direct-messages/:counterpartyKey`
  - 返回与某个对方的消息流
- `POST /direct-messages/:counterpartyKey`
  - 发送消息，提交 `body_json`
- `POST /direct-messages/:shared_message_id/read`
  - 记录已读
- `POST /direct-messages/:shared_message_id/attest`
  - 手动或后台补做 attestation
- `GET /direct-messages/:counterpartyKey/integrity`
  - 查看该私聊线程的完整性状态

## 运行时组件

建议拆成以下逻辑单元：

- **DirectMessageService**
  - 负责槽位排序、线程识别、列表聚合
- **MessageFactCoordinator**
  - 负责 canonical fact、`shared_message_id`、`message_hash`、`prev_message_hash`
- **CiphertextBuilder**
  - 负责三份密文生成
- **ReplicaWriter**
  - 负责双写与回滚
- **ReceiptUpdater**
  - 负责 read / attested 字段更新
- **IntegrityChecker**
  - 负责链校验与冲突检测
- **RepairJob**
  - 负责严重故障后的对账与解封

## 测试策略

### Schema

1. `direct_messages` 能完整承载私聊消息事实、双侧密文、双侧回执
2. 旧 `reasoning_messages` 可被完全移除

### Fact Layer

1. 双写成功才返回成功
2. 任一侧失败则整体失败并回滚
3. 回滚失败会触发禁发与修复流程
4. 双方数据库中的 `shared_message_id / message_hash / prev_message_hash` 完全一致

### Body JSON

1. `text`、`mention`、`link`、`red_packet` 可稳定参与 hash
2. JSON 字段顺序变化不会导致 `message_hash` 不一致
3. 未识别类型仍能存取与校验

### Read / Attestation

1. `read_at_a/read_at_b` 与 `attested_at_a/attested_at_b` 可独立推进
2. 自动 attestation 成功后不会打扰用户
3. 能准确回答谁已读、谁未读、谁已 attested、谁未 attested

### Integrity

1. 篡改密文对应的 canonical fact 会触发校验失败
2. 同一消息允许三份密文不同，但 `message_hash` 必须相同
3. 检测同一 `shared_message_id` 对应不同 `message_hash` 时标记冲突

## 验收标准

- `reasoning_messages` 被新的 `direct_messages` 单表模型替代
- 私聊消息只有在双方都写入成功时才算发送成功
- 群聊不复用本表，逻辑完全分叉
- 每条消息拥有稳定 canonical fact、`message_hash`、`prev_message_hash`
- 默认 UI 不要求用户频繁手动 attest
- 系统能准确回答谁已读、谁未读、谁已 attested、谁未 attested
- participant 数据库不保存明文 `body_json`

## 风险与权衡

### 风险 1：单表会比较宽

这是主动接受的 tradeoff，因为当前明确只做私聊，固定双边槽位比多表模型更简单。

### 风险 2：A/B 槽位写错会导致状态污染

因此必须把 `party_a_key/party_b_key` 排序规则封装成唯一 helper，并在所有写路径复用。

另外，`sign_a/sign_b` 采用 `base58`，目的就是让签名串更短、更贴近现有公钥字符串风格。

### 风险 3：未来若做群聊必须重开新模型

这是有意识的产品边界，不是缺陷。未来群聊将走独立表和独立协议，不在本设计上兼容演进。
