# 长耗时推理流的 SSE 保活设计

## 概述

当前推理链路已经统一收敛到 `AvatarInferenceRuntime`，但其流式接口在进入 decomposition、recall assessment、最终 generation 前的准备阶段时，可能出现较长时间没有任何 SSE 输出。对客户端、网关或反向代理而言，这段静默会被误判为连接失活，从而在真正 token 到来前提前超时。

这次改动的目标不是增加新的阶段协议，也不是把 runtime 的内部阶段暴露给外部调用方，而是在现有两条流式出口上增加最小化的 SSE keepalive，让连接在长耗时推理阶段保持活跃，同时继续维持 OpenAI 兼容语义。

## 问题

- `/:pubKey/reasoning/message` 在推理准备阶段可能长时间没有事件，导致前端请求超时。
- `/ai/v1/chat/completions` 也会在 unified runtime 返回首个真实 stream event 前静默过久。
- 现有链路虽然已经有 `thinking`、`token`、`done`、`error` 等业务事件，但这些事件依赖内部阶段真正产出结果，不能承担“纯保活”职责。
- 如果为了保活而新增对外阶段事件，会让 OpenAI 兼容出口暴露非标准语义，增加第三方客户端兼容风险。

## 目标

- 为 `/:pubKey/reasoning/message` 增加最小 SSE 保活，避免长静默超时。
- 为 `/ai/v1/chat/completions` 增加最小 SSE 保活，且不破坏严格 OpenAI 兼容语义。
- 不新增任何对外必须理解的阶段事件或 JSON schema。
- 保活逻辑尽量集中，避免两条 route 各自漂移。

## 非目标

- 不设计新的公开阶段协议。
- 不要求客户端消费或理解保活帧。
- 不修改 unified runtime 的业务推理语义。
- 不改动 non-stream 路径。

## 设计决策

| 决策项          | 选择                                          | 理由                                              |
| --------------- | --------------------------------------------- | ------------------------------------------------- |
| 保活帧内容      | SSE comment heartbeat（如 `:\n\n`）           | 属于协议级注释，不会被当成业务数据事件            |
| 保活位置        | stream route 写出层                           | 不扩散对外协议语义，也不污染 runtime 业务事件模型 |
| OpenAI 兼容策略 | 只发 comment heartbeat，不发新 event 或空数据 | 尽量保持严格兼容                                  |
| 触发方式        | 基于“距上次真实写出”的静默检测做周期保活      | 覆盖长等待，又不虚构 runtime 内部阶段钩子         |
| 去重策略        | 有真实输出时停止发送保活                      | 降低噪音，避免无意义 chunk                        |
| 默认时序        | 静默超过 5s 开始，每 5s 一次 heartbeat        | 简单、共享、可测试，也足以压低常见代理超时风险    |

## 核心方案

### 1. 保活是 SSE 输出层职责，不是公开协议职责

本次不在 unified runtime 中引入新的公开事件类型。runtime 仍只产出它当前已经定义的业务事件；保活由流式 route 的 SSE 写出层负责。

这样可以保持两层边界清晰：

- runtime 负责推理编排与真实业务输出
- route 负责把“长时间无输出的等待”包装成连接级 keepalive

这也符合本次目标：只解决超时，不引入新的外部语义。

### 2. 两条流式出口都使用同一种最小保活帧

`/:pubKey/reasoning/message` 与 `/ai/v1/chat/completions` 都只发送最小 SSE comment heartbeat，例如：

```text
: keepalive

```

或更极简的：

```text
:

```

该帧不承载阶段名、turn id、JSON body 或解释文本。客户端通常会直接忽略它，不会影响现有逻辑；网络层看到连接有持续输出，则不会因为静默而误判超时。

### 3. 保活只覆盖 route 可观测的静默窗口

本次不承诺 unified runtime 内部每个异步子步骤的精确“开始/结束”边界，因为 route 写出层并不可见这些内部钩子。保活只覆盖 route 可观测的静默窗口，并统一基于“距上次真实写出已静默多久”做判断，例如：

1. 等待 `createRequest()` 返回期间
2. 等待 `runStream()` 首个真实输出期间
3. 两次真实输出之间如果再次出现过长静默

因此 stream 包装层采用以下策略：

- 每次写出真实业务内容后，刷新 `lastRealWriteAt`
- 如果 `now - lastRealWriteAt >= 5s`，发送一次 comment heartbeat，并把下一次 heartbeat 继续按 5s 递推
- 只要又写出了真实业务内容，就重置静默计时；后续若再次静默超阈值，再发送下一次 heartbeat

这样虽然不直接暴露内部 LLM call 边界，但可以稳定覆盖真正会导致超时的外部静默窗口。

### 4. 当前静默窗口内有真实流输出时，应停止本轮保活

一旦 route 已经开始写真实业务内容，保活就失去价值，继续发送只会制造噪音。因此需要有一个统一规则：

- 在收到真实 token / chunk / done / error 写出后，停止当前等待窗口的保活定时器
- 若后续再次进入新的长等待窗口，可重新开启下一段保活

这里的“真实输出”在两条 route 中定义略有不同：

- `/:pubKey/reasoning/message`：`thinking`、`token`、`done`、`error` 都算真实输出
- `/ai/v1/chat/completions`：OpenAI 风格 JSON chunk 和 `[DONE]` 算真实输出；comment heartbeat 本身不算业务输出

## 具体落点

### `packages/server/src/routes/reasoning.ts`

- 在 route 的流式执行包装层加入 keepalive helper
- 在等待 runtime 准备或等待其真实事件期间按阈值发送 comment heartbeat
- 保持原有 `thinking` / `token` / `done` / `error` 事件不变

### `packages/server/src/routes/ai-chat-completions.ts`

- 在整个 stream 生命周期内，基于“距上次真实写出”的静默检测加入 comment heartbeat
- 不新增新的 `event:` 名称，不输出新的 JSON 结构，也不发送空 `data:`
- 最终仍只输出 OpenAI 风格 chunk 与 `[DONE]`

这里需要特别注意：该 route 当前会先写一个 OpenAI 风格 `message_start` chunk。这个 chunk 本身算一次真实写出，因此 heartbeat 不能只盯“首个 chunk 之前”，而应在它之后如果再次出现超过阈值的静默时继续生效。

### 共享 helper

保活实现应该抽到一个小型共享工具，而不是在两条 route 内各写一套定时器。这个 helper 只关心：

- 如何写一个 SSE comment heartbeat
- 如何开启/停止定时保活
- 如何包裹一个 route 可观测的 await 窗口

helper 不应理解 runtime 的业务阶段，也不应拥有任何 reasoning 专属知识。

### 时序 contract

- 两条 route 共用同一套默认时序：静默超过 `5s` 开始，每 `5s` 发送一次 comment heartbeat。
- 真实业务写出后立即重置静默计时。
- 这些值应集中定义，避免两条 route 漂移。
- 测试中应通过 fake timers 或显式 gate 控制稳定触发，不依赖真实睡眠时间。

## 错误处理

- keepalive 写出失败按现有 SSE 流失败路径处理，不单独吞错。
- 停止定时器必须放在 `finally`，避免异常路径泄漏定时任务。
- helper 必须保证即使被多次 stop 也幂等。
- client disconnect / abort 时也必须停止 heartbeat，避免后台继续写流。

## 前置假设

- 当前两条 route 所依赖的 SSE 栈支持 comment heartbeat 及时 flush 到测试客户端，而不是被缓冲到连接结束才一起送达。
- 如果端到端验证显示 comment heartbeat 无法在静默窗口内被客户端读到，本方案即视为未达标，需要先解决 flush/buffering 问题。

## 测试策略

### reasoning route

- 当内部推理被 gate 住、真实事件尚未产出时，响应体中应已经出现至少一个 comment heartbeat。
- 当真实 `done` 或 `token` 到来后，原有事件格式保持不变。
- 连接结束、报错或客户端中断后，不应继续发送 heartbeat。

### OpenAI route

- 当 unified runtime 在首个真实 chunk 前被延迟时，响应体中应已出现 comment heartbeat。
- 当 `message_start` 已写出后，若后续再次静默超过阈值，响应体中仍应出现 comment heartbeat。
- 现有 OpenAI 风格 chunk 解析不应被破坏；测试仍应能读到 `chat.completion.chunk` 与 `[DONE]`。
- comment heartbeat 不应要求测试或客户端解析出新的业务 schema。
- 首个真正的 OpenAI JSON chunk 语义保持不变。

### flush 可达性

- 端到端测试必须证明 heartbeat 能在静默窗口内被测试客户端读到，而不是只在连接结束后一次性拿到。

## 风险与缓解

### 1. 部分解析器如何对待非业务帧并不一致

风险在于不同客户端对 heartbeat 的容忍度不同。这里优先选择 SSE comment，而不是空 `data:`，以降低被当成业务消息的概率：

- 不使用新的 event 名称
- 不发送额外 JSON 结构或空 `data:`
- 保持真实业务 chunk 不变

如果后续发现某个具体客户端对 comment heartbeat 仍有异常，再针对该客户端补专项兼容性验证；本轮先采用协议上更保守的心跳格式解决超时。

### 2. 定时器泄漏或重复发送

如果 route 内各自实现保活，很容易在异常分支或多阶段等待中泄漏定时器。因此必须抽成共享 helper，并要求 `start/stop` 幂等、`finally` 清理。

### 3. 测试过于依赖 chunk 精确布局

保活会让流响应中多出额外 heartbeat，因此测试不能继续假设“第一个块必然是业务 chunk”。测试应改为验证：

- 保活先于真实输出出现
- 真实输出最终仍完整出现

## 验收标准

- `/:pubKey/reasoning/message` 在长耗时推理阶段会输出 SSE comment heartbeat，避免长静默。
- `/ai/v1/chat/completions` 在首个真实 OpenAI chunk 前会输出 SSE comment heartbeat。
- `/ai/v1/chat/completions` 在 `message_start` 之后如果再次出现长静默，也会继续输出 SSE comment heartbeat。
- 两条链路都不新增客户端必须理解的新协议语义。
- 现有真实流输出格式保持兼容。
- heartbeat 能被测试客户端在静默窗口内实际读到，而不是只停留在服务端写缓冲中。
