# OpenCode Session 接管实验设计

## 概述

本实验要验证一个最小闭环：ReMi 不作为 OpenCode 的底层模型提供方，而是作为“用户侧分身控制器”接管某个指定的 OpenCode Session，在 Agent 每一轮完成输出后，代表用户自动给出下一条 prompt。

这里的核心不是“让 OpenCode 调我的分身”，而是“让分身成为这个 Session 的持续输入者 / 验收者”。脚本会持续观察一个指定 `sessionId` 的状态，在 Session 进入可继续输入的阶段后，读取最近一段上下文，做一层 role switch 后调用分身，并把分身的整段回复原样作为 OpenCode Session 的下一条 `user` 消息发回去。

MVP 目标是先验证自动接管闭环，不在本期引入终止判定、结构化 verdict、事件流订阅、持久化恢复或多 Session 管理。

本期明确只覆盖**无 permission / approval 阻塞的普通 Session**。如果 Session 进入权限请求、人工确认或其他无法从消息尾部稳定判断的状态，脚本应将其统一视为 `ambiguous`，保持等待，不尝试接管。

本实验默认 **takeover 是排他的人工约定**：脚本运行期间，不应再由人工或其他自动化向同一 Session 注入新的 `user` 输入。本期不尝试通过程序自动识别外部写入来源。

## 目标

- 接受外部传入的一个固定 OpenCode `sessionId`
- 通过 OpenCode 本地 HTTP API 读取该 Session 最近消息
- 依据 OpenCode Web UI 相近语义判断该 Session 是否已进入“可继续输入”的状态
- 将最近窗口消息转换为分身可消费的镜像对话
- 调用分身一次，并将分身完整输出原样回写为 OpenCode 的下一条 `user` 消息
- 让脚本持续循环运行，直到用户手动退出进程

## 非目标

- 不管理多个 Session
- 不自动发现目标 Session
- 不引入 `pass / continue` 之类结构化控制协议
- 不引入 XML / JSON 输出约束
- 不订阅 OpenCode SSE 事件流
- 不依赖 `/session/status` 作为触发依据
- 不做 crash recovery、断点恢复或本地持久化状态文件
- 不处理 permission approval 流程

## 核心产品判断

### 1. 分身是“下一提示词生成器”，不是执行模型

OpenCode 内部的 Agent 仍然负责干活、调工具、生成代码与执行命令。分身不替代这些能力，而是站在用户位置决定“下一轮应该说什么”。

因此这个实验的最小闭环是：

1. OpenCode 先完成一轮 assistant 输出
2. 分身读取这一轮上下文
3. 分身生成下一条 prompt
4. 脚本把这条 prompt 作为用户消息发回同一个 Session

### 2. 需要做一层会话镜像，而不是直接转发历史

OpenCode Session 中的角色语义，对分身来说正好是反过来的：

- OpenCode `assistant` 是执行层 AI 的输出，对分身来说应视为 `user`
- OpenCode `user` 是当前的上游指令，对分身来说应视为 `assistant`
- `system` 对本实验无帮助，应在镜像时移除

这样分身看到的上下文更接近“我正在和一个执行体对话，并决定下一步怎么驱动它”。

### 3. 触发语义要对齐 OpenCode Web UI，而不是信任 `/session/status`

调研与本地验证表明，`GET /session/status` 只是内存中的 prompt-loop 状态表，并不可靠反映工具执行中的真实状态。出现“assistant 消息中的 tool part 仍在 `running`，但 `/session/status` 返回 `{}`”是正常现象。

因此本实验不再使用 `/session/status`。触发条件改为对齐 Web UI 的实际语义：主要看最新 assistant message 是否已经 `completed`，并结合 tool part 是否仍在运行。

## 方案选择

在访谈阶段讨论过三种方案：

1. 纯轮询接管器
2. 带本地状态持久化的轮询接管器
3. 全控制器型接管器

本实验选择 **方案 A：纯轮询接管器**。

理由：

- 实现最小，最适合先验证概念
- 可以接受轻微轮询延迟
- 避免过早引入恢复逻辑与状态文件
- 与“手动指定 `sessionId`”的实验方式匹配

## OpenCode API 边界

本实验只依赖 OpenCode 已公开的本地 HTTP API：

- `GET /session/:id`：确认 Session 存在
- `GET /session/:id/message?limit=N`：读取最近消息窗口
- `POST /session/:id/message`：候选回写入口，用于向指定 Session 追加下一条用户消息

明确不使用：

- `GET /session/status`：状态语义不足，不作为触发依据
- `GET /event`：虽然官方支持 SSE，但本实验明确选择轮询，降低实现复杂度

### 启动前硬前置校验

`POST /session/:id/message` 是否与 Web UI 中“用户提交下一条 prompt”完全等价，必须在进入正式轮询前完成一次人工确认。

本期的最小前置条件固定为：

1. 先确认目标 Session 存在
2. 人工在一个独立测试 Session 上验证当前回写 API 能触发新一轮 agent 执行
3. 验证成功后，才允许把该 API 配置为 takeover 脚本的正式回写入口

如果这一前置条件不成立，脚本必须 fail fast，不进入主循环。

实现落点固定为：

- 脚本必须要求一个显式参数，例如 `--write-api-confirmed=true`
- 未提供该参数时直接退出
- 该参数只表示“操作者已经人工确认当前回写 API 与 Web UI submit 等价”

## 可接管态判定

### 主数据源

唯一主数据源为：

- `GET /session/:id/message?limit=N`

### 判定状态机

脚本每轮轮询后，基于最近消息窗口判断目标 Session 当前属于以下哪一类：

#### `busy`

满足任一条件即可视为仍在执行中：

- 尾部最后一条消息是 `assistant`，且不存在 `time.completed`
- 尾部最后一条消息是 `assistant`，且其任一 `tool` part 满足 `state.status = "running"`

此时脚本只等待，不调用分身。

#### `idle-runnable`

同时满足以下条件时，视为这一轮已经结束，可以由分身介入：

- 尾部最后一条消息是 `assistant`
- 该 message 存在 `time.completed`
- 该 message 中不存在 `state.status = "running"` 的 `tool` part
- 该 `assistant message id` 还没有被本进程处理过

此时脚本调用分身一次，并把分身回复回写给 OpenCode。

#### `ambiguous`

例如：

- 当前窗口尾部最后一条消息不是 `assistant`
- 当前窗口还没有 assistant message
- message 结构异常
- 尾部 assistant 提取后没有任何可消费文本
- 最近窗口表现出本期未定义的状态

这类情况统一视为“先继续轮询，不触发”。

### 状态判定顺序

为避免实现歧义，判定顺序固定如下：

1. 若尾部最后一条消息不是 `assistant`，判定为 `ambiguous`
2. 若尾部 assistant 任一 `tool` part 为 `running`，判定为 `busy`
3. 若尾部 assistant 不存在 `time.completed`，判定为 `busy`
4. 若尾部 assistant 文本抽取结果为空，判定为 `ambiguous`
5. 若该尾部 assistant id 已经是 `committed`，判定为 `ambiguous`
6. 其余情况判定为 `idle-runnable`

### 轮次选择算法

为了避免“最近一条 assistant message”语义不精确，本期将轮次锚点收窄为：

- **只有当消息窗口的尾部最后一条 message 是 `assistant` 时，才允许进入 takeover 判定**

这样做的含义是：

- 如果尾部最后一条是 `user`，说明上一轮尚未完整开始或本轮边界不清晰，直接判为 `ambiguous`
- 如果固定窗口内无法提供足够的对话上下文，分身看到的就是这个被裁剪后的窗口，本期不再额外要求必须包含上一条 `user`

这比“从窗口中找最近一条 assistant”更保守，但更容易得到稳定实现。

## 去重策略

本实验使用单一去重锚点：

- 最近一条已完成的 OpenCode `assistant message id`

规则如下：

- 同一条 `assistant message id` 只允许触发一次分身
- 一旦脚本已经用这条 assistant 消息驱动过一次分身，就算后续轮询仍看到相同上下文，也不得重复发送下一条 prompt
- 当 OpenCode 产出新的 assistant 完成消息后，才允许开启下一轮分身调用

因为当前选择的是方案 A，所以这个去重锚点只保存在进程内存中。脚本重启后，允许重新从当前轮次开始接管。

## 消息镜像规则

### 输入窗口

- 从 OpenCode 读取最近 `N` 条消息
- `N` 作为脚本参数可配置，默认建议为 `8`
- 不做动态扩窗
- 固定窗口内有什么，就镜像什么

### 角色转换

镜像为分身输入时执行以下规则：

- 丢弃所有 `system`
- OpenCode `assistant` -> 分身输入中的 `user`
- OpenCode `user` -> 分身输入中的 `assistant`

### 内容抽取算法

为了降低 MVP 复杂度，镜像阶段采用固定算法，不留给实现者主观解释：

1. 只处理 message 级别的 `user` / `assistant`
2. 对每条 message，按 `parts` 原始顺序扫描
3. 只保留 `type = "text"` 的 part 的 `text`
4. 将同一 message 内多个文本 part 用 `\n\n` 拼接
5. 若一条 message 提取后文本为空，则丢弃该 message
6. `reasoning`、`step-start`、`step-finish`、`patch`、`snapshot` 等 part 在本期全部忽略
7. `tool` part 不展开正文，但为避免上下文完全丢失，固定生成一行摘要：`[tool:<tool-name>:<status>]`

因此本期的镜像结果是一个纯文本对话窗口，而不是 OpenCode message JSON 的结构化映射。

### 连续同角色与空消息

- 连续同角色消息不合并，按原消息顺序保留
- 只要提取出的文本非空，就保留该 message
- 提取后为空的消息直接丢弃
- 本脚本上一轮刚写入的 `user` prompt，在下一轮镜像时应正常包含在窗口中，否则上下文会断裂

## 分身调用协议

### 当前 MVP 的极简约定

本实验暂时不引入 XML、JSON 或 verdict 协议。

分身每一轮只做一件事：

- 接收镜像后的最近对话窗口
- 返回一段完整文本回复

脚本收到这段文本后，不做额外解析，直接将其作为 OpenCode Session 的下一条 `user` prompt 发回。

发送前固定执行：

- `trim()`
- 若结果为空字符串，则视为无效结果，不回写
- 本期允许与前一轮相同的 prompt 文本，不做内容去重拦截

## 回写接口契约

一旦完成前置人工确认，本期固定采用以下最小回写请求体：

```json
{
  "parts": [
    {
      "type": "text",
      "text": "<avatar full reply>"
    }
  ]
}
```

约定：

- 路径：`POST /session/:id/message`
- 本期不显式覆盖 `model`、`agent`、`system`、`tools`、`noReply`
- 让 OpenCode 继续沿用该 Session 当前既有的运行上下文

成功响应判定固定为：

- HTTP 状态码为 `200`
- 实现必须按严格等值处理 `status === 200`，不接受其它 `2xx`
- 响应体中存在 `info`
- `info.role = "assistant"`

只要同时满足这三个条件，就视为“回写成功且 OpenCode 已经接受并完成本轮执行”，可以把当前 anchor 从 `write_pending` 迁移到 `committed`。

若不满足上述条件，即使 HTTP 成功，也视为不确定错误并直接退出进程。

### 这样做的意义

- 先验证“分身可持续生成下一条 prompt”这个最小概念
- 避免过早把实验复杂度压在协议设计上
- 为后续再引入 `pass / continue`、XML verdict、停止条件等机制留出空间

## 回写规则

当分身返回非空文本后：

1. 脚本调用启动前已经校验通过的回写 API
2. 使用 OpenCode 的普通用户消息入口提交一条新的 prompt
3. 这条 prompt 的内容就是分身的完整输出

注意：

- 回写到 OpenCode 时，角色始终是 `user`
- 不做 assistant 模拟，也不写 system
- 本实验不使用 `prompt_async`，优先使用同步入口，便于调试与日志观察
- 但前提仍是“该同步入口经验证确实能启动下一轮 agent 执行”

## 轮询循环

脚本生命周期如下：

1. 启动，校验目标 `sessionId` 是否存在
2. 进入无限轮询
3. 每轮读取最近 `N` 条消息
4. 判断当前是否处于 `busy / idle-runnable / ambiguous` 之一
5. 若为 `busy`，睡眠 `poll_ms` 后继续
6. 若为 `ambiguous`，打印原因，睡眠 `poll_ms` 后继续
7. 若为 `idle-runnable`，镜像消息窗口并调用分身
8. 将分身完整输出回写到该 Session
9. 将本轮 anchor 从 `write_pending` 置为 `committed`
10. 返回第 3 步，持续循环

进程不会自行结束，只在以下情况下退出：

- 用户手动中断，例如 `Ctrl+C`
- 目标 Session 不存在
- OpenCode API 连续 `20` 次轮询失败
- 回写阶段出现不确定错误

## 参数设计

脚本至少需要以下参数：

- `--session-id`：目标 OpenCode Session ID
- `--window-size`：读取的最近消息数，默认 `8`
- `--poll-ms`：轮询间隔，默认可设为 `1500-3000ms`
- 分身调用所需的基础参数，例如 base URL、认证信息、模型标识等

## Anchor 状态机

每个可处理的尾部 assistant anchor 只允许处于以下三种状态之一：

- `unprocessed`
- `write_pending`
- `committed`

状态迁移规则：

1. 首次发现一个满足 `idle-runnable` 条件的 assistant id 时，状态为 `unprocessed`
2. 在真正发起回写前，先把该 assistant id 标记为 `write_pending`
3. 若回写 API 返回明确成功响应，则立即标记为 `committed`
4. 如果回写过程中发生超时、连接中断或其他不确定错误，则直接退出进程，不在本期做自动重试

## 错误处理

### OpenCode 侧

- `GET /session/:id` 返回 404：直接退出
- `GET /session/:id/message` 临时失败：记录日志并重试
- 回写发生不确定错误：直接退出进程，由人工检查 Session 实际状态后再决定是否重启脚本

### 分身侧

- 分身调用失败：记录日志，不回写 prompt，继续轮询
- 分身返回空文本：视为无效结果，不回写 prompt

### 判定侧

- 如果尾部 assistant message 结构不符合预期，则保守处理为 `ambiguous`
- 不因为单轮解析失败就退出整个进程

### Ambiguous 侧

- 如果连续多个轮询周期都处于 `ambiguous`，脚本应持续打印当前尾部 message id 与原因，便于人工定位
- 对 permission / approval 等本期未覆盖状态，也统一按 `ambiguous` 处理

## 最小验收标准

本实验至少满足以下任一验证标准，才算闭环跑通：

1. 在一个真实 OpenCode Session 上，连续 1 轮完成以下链路：
   - assistant 完成
   - 脚本判定 `idle-runnable`
   - 分身被成功调用
   - 分身输出被成功写回 OpenCode
   - OpenCode 因这条写回消息成功启动下一轮执行
2. 更理想的标准是连续 3 轮重复以上链路，无人工干预

建议日志中至少打印：

- 当前尾部 message role 与 id
- 当前判定状态
- 已处理 assistant anchor id
- 分身调用是否成功
- OpenCode 回写是否成功

## 风险与边界

### 1. 没有停止条件，理论上会无限推进

这是当前实验的刻意设计：只要 Session 每一轮结束后还能继续输入，分身就会永远接下一条 prompt，直到用户主动终止进程。

这既是实验目标，也是风险来源。它意味着：

- 可能出现无意义循环
- 可能出现 prompt 漂移
- 可能出现分身与执行层互相放大错误方向的情况

这些问题不在本期解决，而是作为后续是否需要引入 verdict 协议和终止条件的依据。

### 2. 方案 A 不做恢复

脚本重启后，进程内去重信息会丢失，可能从当前轮次重新接管一次。这是可接受的实验代价。

### 3. 当前不处理 permission wait 场景

如果 OpenCode Session 因 permission request 卡住，而消息结构又不足以完全表达这一点，脚本可能需要额外规则才能避免误判。本期先不解决，后续若遇到真实阻塞再补充。

## 后续演进方向

如果本实验闭环跑通，下一阶段优先考虑：

1. 为分身增加 XML verdict 协议，支持 `pass / continue / stop`
2. 引入本地状态持久化，支持进程重启恢复
3. 加入 permission / blocked 场景识别
4. 支持多个 Session 的统一调度与接管
5. 为镜像规则补充更好的 tool-output 摘要策略
