# 目标管理与主动调度 MVP 设计

## 概述

为 ReMi 增加第三条 MVP 主线：目标管理与主动调度。除了访谈流采集灵魂锚点、推理流代表本体回答问题，分身还需要围绕用户目标持续主动推进任务，不等待用户显式发消息。

MVP 聚焦验证三个核心闭环：

1. 分身可以维护一棵目标树，而不是只维护一个平铺任务池
2. 分身被平台调度器周期性唤起后，可以从根节点贪心选择一条路径推进
3. 可执行叶子节点对应外部执行层中的 OpenCode Session，分身可以继续推进这个 Session

MVP 暂不实现用户付费预算、结构化验收测试和精确百分比进度，先验证“树结构 + 调度 + Session 推进”的最小闭环。

## 设计决策

| 决策       | 选择                        | 理由                                         |
| ---------- | --------------------------- | -------------------------------------------- |
| 目标结构   | 树形节点                    | 父节点定义存在价值，分身从根节点向下贪心访问 |
| 可执行单元 | `session` 叶子节点          | 一个可执行叶子就是一个 OpenCode Session      |
| 单次激活   | 一条路径 + 最多一次对外执行 | 审计、预算和公平调度都更稳定                 |
| 状态真相   | 本地树 + 执行层刷新         | `session` 运行态不能只信本地数据库           |
| 依赖模型   | 显式 `dependency_ids`       | 并发允许存在，但依赖不能靠 LLM 猜            |
| 完成判定   | 先允许分身标记 `done`       | MVP 先验证主动调度闭环，不先做验收框架       |
| 预算模型   | 仅平台预算                  | 先排除用户预算，避免计费与防篡改复杂度       |
| 平台调度   | 固定频率公平轮询            | 先用 `.env` 可配置的简化方案验证产品行为     |

## MVP 范围

**包含：**

- 树形目标结构
- `goal` / `session` 两类节点
- 每节点最多 5 个子节点的硬约束
- 从根节点开始的贪心选路
- 显式依赖边
- 执行层状态刷新
- 平台公平轮询调度
- OpenCode Session 的状态查询、history 查询与 prompt 追加
- 分身在激活中进行局部树维护

**不包含：**

- 用户付费预算
- 令牌桶预算实现
- skill-like 验收器定义与执行
- 基于测试结果的完成判定
- 百分比 progress 聚合
- 节点权重加权聚合

## 核心对象模型

### `goal_node`

MVP 只保留当前闭环真正需要的字段，统一使用 snake_case。

| 字段                  | 类型                                                        | 说明                                                   |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| `id`                  | `string`                                                    | 节点稳定标识                                           |
| `parent_id`           | `string \| null`                                            | 树结构，根节点为 `null`                                |
| `type`                | `'goal' \| 'session'`                                       | 组织节点或可执行叶子                                   |
| `title`               | `string`                                                    | 节点短标题                                             |
| `objective`           | `string`                                                    | 节点目标描述                                           |
| `status`              | `'todo' \| 'running' \| 'blocked' \| 'done' \| 'cancelled'` | 工作流状态                                             |
| `dependency_ids`      | `string[]`                                                  | 显式依赖的节点 ID 列表                                 |
| `execution_base_url`  | `string \| null`                                            | 仅 `session` 节点使用，绑定该节点所属的执行层 API 入口 |
| `external_session_id` | `string \| null`                                            | 仅 `session` 节点使用，执行层 / OpenCode Session 标识  |

### 刻意不进入 MVP 的字段

- `progress`：先不做百分比进度，只做派生展示，如“已完成子节点数 / 总子节点数”
- `weight`：父节点先不用加权聚合，避免过早引入人为复杂度
- `acceptance_spec_ref`：验收框架暂不进入 MVP
- `execution_result`：执行结果表和测试统计后续版本再补

## 节点状态与依赖规则

### 状态定义

- `todo`：当前可被选路
- `running`：仅 `session` 节点允许使用；执行层查询显示该 Session 当前正在运行
- `blocked`：依赖未满足，当前不可推进
- `done`：当前先允许由分身判断已完成
- `cancelled`：节点被放弃，不再参与调度

### 关键边界

- `goal` 节点只允许使用 `todo / blocked / done / cancelled`
- `goal` 节点状态主要由 ReMi 本地树维护
- `session` 节点状态不是纯本地事实，必须在每次行动机会开始时通过执行层 API 刷新
- 本地数据库不是 `session` 运行态的唯一真相源，本地更像树结构与决策缓存

### 依赖规则

- 依赖通过 `dependency_ids` 显式表达
- `dependency_ids` 只允许引用同一棵目标树中的其他节点
- 禁止自依赖与环
- 只有依赖节点全部进入 `done`，依赖才算满足
- 若依赖节点为 `cancelled`，则当前节点保持 `blocked`，直到分身改写依赖关系
- 依赖未满足时，该节点当前视为 `blocked`
- 分身在选路前先过滤依赖未满足节点，再做价值判断

## 单次激活流程

一次激活代表分身获得一次行动机会。触发源在 MVP 中只有平台预算。

### 标准流程

1. 平台调度器触发一次分身激活
2. 先查询当前目标树内相关 `session` 节点的执行层状态
3. 结合执行层查询结果、本地树结构与依赖关系，重算本轮可见状态
4. 从根节点开始逐层贪心选择当前最有价值的子节点向下访问
5. 沿路径允许执行局部树维护：
   - 新建 `goal` 节点
   - 新建 `session` 节点
   - 删除、取消或替换旧节点
   - 调整节点状态
6. 若最终命中一个可推进的既有 `session` 节点，则向执行层追加一条新的 prompt input
7. 本次激活立即结束

### 单次激活约束

- 每次只访问一条路径
- 每次最多一次对外执行动作
- 创建外部 `session` 或推进既有 `session` 后，本次激活立即结束
- “创建外部 session”和“向既有 session 追加 prompt”都算一次对外执行，单次激活只能二选一
- 如果平台预算后续仍继续释放行动机会，则可以立刻开始下一轮激活，不必等待刚刚那个 Session 完全结束

## 贪心选路与树维护

### 父节点的作用

父节点不是可执行任务本身，而是定义“为什么这条分支存在”。分身每次都从根节点开始访问，是为了保证局部选择始终服从全局目标，而不是退化成平铺任务池上的盲目轮询。

### 选路规则

在任意 `goal` 节点下，分身只在当前层的子节点中做判断：

1. 先排除不可选节点：`done`、`cancelled`、依赖未满足的节点
2. 若某个子节点对应的子树里当前没有可推进的 `session` 节点，则尝试次优子节点
3. 在剩余候选里，由分身判断当前最有价值的子节点
4. 如果该子节点是 `goal`，继续向下访问
5. 如果该子节点是 `session`，则本轮目标是推进这个 Session

### 子节点上限

- 每个节点下的子节点最多 5 个
- 这是硬约束，不允许临时超限
- 若分身认为需要新增第 6 个子节点，必须先在当前层做一次结构整理
- 结构整理可以是删除、取消或替换一个旧节点

### 新建节点

一次激活里，分身可以自主决定新建：

- `goal` 节点：用于继续组织问题空间
- `session` 节点：用于创建新的可执行 OpenCode Session

如果新建的是 `session` 节点，则该节点必须立即具备：

- `execution_base_url`
- `external_session_id`

MVP 中，新建外部 `session` 和推进既有 `session` 节点不能在同一次激活里同时发生。这样可以保持“单次激活最多一次对外执行动作”的硬约束。

## 执行层边界

ReMi 不是直接执行所有动作的系统，而是目标树调度中枢。执行层是一个独立进程，对外暴露 Base URL / API，并负责维护 Session 的运行态。

MVP 中，ReMi 与执行层的最小协作能力是：

- 健康检查
- 创建新的 Session
- 查询某个 Session 当前是否正在运行
- 获取某个 Session 的 history messages
- 向某个 Session 追加新的 prompt input

这些能力已经足以支撑“创建 Session / 读取上下文 / 决定下一步 / 推进既有 Session”这一闭环。

## 执行层 API 协议

### 鉴权

- 平台服务端持有一个根种子，放在 `.env`
- 服务端根据 `user_identity_pubkey` 确定性派生一对专用 `ed25519` 密钥
- 私钥不持久化，需要调用执行层 API 时实时派生
- 用户只拿到 `execution_trust_pubkey`，并将其配置到需要信任 ReMi 的执行层
- 执行层只信任这个 `execution_trust_pubkey` 对应的请求签名

这样可以保证：

- 用户主私钥不参与执行层调用
- 能发起主动调用的只有平台
- 用户无法伪造平台侧的主动调度请求

派生算法固定为：

1. `user_identity_pubkey` 使用其 32-byte 原始公钥字节作为输入
2. `seed = HKDF-SHA256(root_seed, salt="", info="remi-exec-v1" || user_identity_pubkey_bytes, len=32)`
3. 使用该 32-byte `seed` 生成 ed25519 keypair
4. 公钥即为 `execution_trust_pubkey`

MVP 中禁止替换这套派生算法，以确保不同实现可以得到完全一致的密钥对。

### 接口列表

术语约定：

- `user_identity_pubkey`：用户原本的身份公钥
- `execution_trust_pubkey`：平台基于 `user_identity_pubkey` 派生出的执行层信任公钥

#### `GET /health`

最小健康检查接口，仅用于确认执行层进程可达。

响应示例：

```json
{
  "data": {
    "status": "ok",
    "execution_trust_pubkey": "xxx",
    "version": "0.1.0"
  }
}
```

MVP 中只要求反映执行层进程是否在线，不要求探测 OpenCode 连通性。

#### `POST /sessions`

创建一个新的外部 Session。这次调用本身就算一次对外执行动作。

`POST /sessions` 不只是建壳，同时也会把 `initial_context` 作为首轮输入提交给执行层。因此“创建 session”本身就代表一次启动执行。

请求示例：

```json
{
  "title": "draft hiring plan",
  "objective": "持续推进招聘流程设计",
  "initial_context": "由 ReMi 提供的目标上下文与当前约束",
  "metadata": {
    "remi_node_id": "node_xxx",
    "user_identity_pubkey": "user_xxx"
  }
}
```

响应示例：

```json
{
  "data": {
    "session_id": "sess_xxx",
    "status": "running"
  }
}
```

这里返回的 `status` 只是写接口回执，不直接驱动 ReMi 本地树状态。ReMi 只在下一轮 `POST /sessions/status/batch` refresh 后，才根据执行层结果更新本地状态。

#### `POST /sessions/status/batch`

批量获取一组 Session 的运行态，用于每轮激活开始前的 refresh。

请求示例：

```json
{
  "session_ids": ["sess_1", "sess_2", "sess_3"]
}
```

响应示例：

```json
{
  "data": {
    "items": [
      {
        "session_id": "sess_1",
        "status": "idle",
        "updated_at": 1770000000000
      },
      {
        "session_id": "sess_2",
        "status": "running",
        "updated_at": 1770000001000
      }
    ]
  }
}
```

#### `GET /sessions/:session_id/messages`

获取某个 Session 的 history messages。

请求参数：

- `cursor`：可选，向前分页游标
- `limit`：可选，返回条数上限

响应示例：

```json
{
  "data": {
    "items": [
      {
        "id": "msg_1",
        "role": "user",
        "content": "请继续推进招聘 JD",
        "created_at": 1770000000000
      }
    ],
    "has_more": false
  }
}
```

#### `POST /sessions/:session_id/messages`

向某个既有 Session 追加一条新的 prompt input。这次调用本身就算一次对外执行动作。

请求示例：

```json
{
  "content": "继续推进这个 session；先检查当前阻塞点，再给出下一步动作。"
}
```

响应示例：

```json
{
  "data": {
    "session_id": "sess_xxx",
    "accepted": true,
    "status": "running"
  }
}
```

这里返回的 `status` 只是写接口回执，不直接驱动 ReMi 本地树状态。ReMi 只在下一轮 `POST /sessions/status/batch` refresh 后，才根据执行层结果更新本地状态。

### 运行态语义

统一规则：所有写接口返回的 `status` 仅表示请求受理时的即时回执，不作为 ReMi 本地状态真相；本地状态只由 refresh 驱动。

执行层返回的最小 `status` 集合：

- `idle`
- `running`
- `cancelled`

其中：

- `session.running` 只由 refresh 后的执行层返回决定
- 本地发出 `append prompt` 不自动把节点写成 `running`
- 只有下一轮 refresh 看到执行层返回 `running`，该节点才视为 `running`

### 执行层状态到本地节点状态的映射

| 执行层状态  | 本地节点状态 | 说明                           |
| ----------- | ------------ | ------------------------------ |
| `idle`      | `todo`       | 非运行态，可继续接收下一条输入 |
| `running`   | `running`    | 只由 refresh 结果确认          |
| `cancelled` | `cancelled`  | 执行层已取消，则本地同步为取消 |

MVP 中，只有 `idle` 的 Session 允许继续接收 `POST /sessions/:session_id/messages`。

### 本地状态重算优先级

每轮 refresh 后，`session` 节点按以下优先级重算本地状态：

1. 执行层为 `cancelled` -> 本地为 `cancelled`
2. 分身已显式标记 `done` -> 本地为 `done`
3. 依赖未满足 -> 本地为 `blocked`
4. 执行层为 `running` -> 本地为 `running`
5. 执行层为 `idle` 且依赖满足 -> 本地为 `todo`

这条优先级规则用于保证 refresh 后可以机械、无歧义地重算 `session` 节点状态。

### 请求签名协议

所有受保护接口都要求带签名头，最小协议如下：

- `X-Remi-Timestamp`：Unix timestamp ms
- `X-Remi-Nonce`：单次请求随机串
- `X-Remi-Body-SHA256`：请求体哈希；使用实际传输的 HTTP body 原始字节做 `sha256(body_bytes)`，再输出为 hex lowercase；空 body 固定为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- `X-Remi-Signature`：对 canonical string 做 ed25519 签名后的 base64 编码结果
- `X-Remi-Execution-Pubkey`：调用方使用的 `execution_trust_pubkey`

canonical string 规则：

```text
<HTTP_METHOD>\n
<PATH_WITH_QUERY>\n
<X-Remi-Timestamp>\n
<X-Remi-Nonce>\n
<X-Remi-Body-SHA256>
```

补充约定：

- `PATH_WITH_QUERY` 签名输入固定为 origin-form `path[?query]`；HTTP/1.1 使用 request-target，HTTP/2/3 使用 `:path`；服务端与代理不得对 path/query 做归一化后再验签
- 受保护接口禁用 request body 压缩；`X-Remi-Body-SHA256` 基于 transfer-decoded 且未做 content-decoding 的原始 body 字节计算；服务端不得对 JSON 做重序列化后再验哈希
- `X-Remi-Signature` 使用 base64 编码
- 允许的时钟偏差窗口为 5 分钟
- nonce 去重窗口为 10 分钟，作用域是 `execution_trust_pubkey + nonce`

受保护接口范围：

- 默认规则：除文档显式标记可匿名的接口外，所有执行层接口默认必须签名

- `GET /health`：必须签名
- `POST /sessions`：必须签名
- `POST /sessions/status/batch`：必须签名
- `GET /sessions/:session_id/messages`：必须签名
- `POST /sessions/:session_id/messages`：必须签名

执行层验签规则：

- MVP 中执行层本地只配置一个 `execution_trust_pubkey`
- 请求头 `X-Remi-Execution-Pubkey` 必须与本地配置值完全相等
- 验证签名
- 校验时间戳在允许窗口内
- 对 nonce 做短时去重，防止重放
- 任一步失败都返回认证错误

### `running` 时的追加语义

- 当执行层状态为 `running` 时，`POST /sessions/:session_id/messages` 必须返回 `409 Conflict`
- MVP 不做队列、合并或覆盖语义
- ReMi 必须等待下一轮 refresh 看到该 Session 回到 `idle` 后，才能再次追加输入
- append 的最终裁决权在执行层实时状态；即使 ReMi 的 refresh 结果仍显示 `idle`，服务端若在写入时已进入 `running`，仍必须返回 `409 Conflict`
- `POST /sessions/:session_id/messages` 必须在执行层内对单个 Session 做原子 check-and-set / lock：只有第一个成功把状态从 `idle` 切到 `running` 的请求可以被 accepted，其余并发请求必须返回 `409 Conflict`

## 平台预算与公平调度

### MVP 只实现平台预算

MVP 暂不实现用户付费预算，只保留未来扩展口。

当前只实现 `platform_budget`：

- 平台提供免费思考额度
- 平台以公平轮转的方式在所有用户分身之间分配行动机会
- 用户越多，单个分身平均获得的激活频率越低

### 调度方式

- 先使用固定频率轮询，而不是令牌桶
- 调度器配置直接放在 `.env`
- 每次轮询触发时，从公平循环队列中选择下一个分身
- 被选中的分身执行一次完整的 `refresh -> recompute -> path_select -> act`

推荐的最小环境变量：

- `PLATFORM_SCHEDULER_ENABLED`
- `PLATFORM_SCHEDULER_INTERVAL_MS`

### 后续扩展方向

令牌桶是更长期合理的预算模型，但不作为 MVP 前提。未来若增加用户付费预算，则应新增一条独立的用户预算激活通道，而不是推翻当前平台公平调度模型。

## 完成语义

MVP 中先允许分身自行标记 `done`，这是为了避免在第一版中同时引入复杂的测试执行与结果解析框架。

这是一种刻意的阶段性退让：

- 当前版本优先验证主动调度是否有产品价值
- 后续版本再把 `done` 的来源迁移到执行层验收结果

因此，这个 MVP 重点验证的是“分身是否能持续推进目标”，而不是“系统是否已经拥有严格的验收测试框架”。

## 测试与验证建议

MVP 完成后，至少验证以下行为：

1. 平台调度器可以按固定频率公平轮询多个分身
2. 分身每次激活都会先刷新执行层状态，再做选路
3. 每次激活最多只推进一个 `session`
4. 分身可以在单次激活中维护树结构并创建新节点
5. 节点数到达上限 5 时，新增节点前必须先整理结构
6. 显式依赖会让节点进入 `blocked`，且依赖满足后重新可选
7. 同一分身可以在连续激活中推动多个不同路径上的 Session

## 后续演进

这个 MVP 的后续自然演进方向是：

1. 引入 `acceptance_spec_ref`，把叶子节点的验收器外部化为 skill-like 定义
2. 引入执行结果表与测试统计，替代分身主观标记 `done`
3. 引入百分比进度与父节点聚合逻辑
4. 把平台固定频率轮询升级为令牌桶预算
5. 增加用户付费预算通道，并将预算真相源放在平台中心账本而不是用户数据库中
