# 分身开放推理接口 MVP 设计

## 概述

为 ReMi 增加一套面向程序调用的分身开放推理接口。该接口不是聊天 UI，而是将用户自己的分身暴露为一个可编程调用的 LLM 风格 API，用于在外部工作流中获取专业建议、操作计划与工具建议。

本期 MVP 只支持**用户调用自己的分身**，不处理用户与用户之间的授权，不处理第三方代调用场景。

对外协议首先兼容 OpenAI 风格 `chat/completions`，但内部实现必须保持协议中立，避免与某一种外部接口形状强耦合。

## 目标

- 提供统一开放入口 `POST /ai/v1/chat/completions`
- 允许调用方以 OpenAI 风格 `messages` 传入任务上下文
- 使用 `model = ReMi-<user_public_key>` 指定分身
- 使用用户自己管理的 `sk-xxxx` token 进行鉴权
- 支持 `stream=true` 的流式返回
- 在服务端对输入消息做分身身份增强与锚点召回增强
- 复用现有推理能力，但对外表现为标准 LLM 接口
- 为未来兼容 `/ai/v1/responses` 与 Anthropic 风格接口预留空间

## 非目标

- 不支持“别人调用我的分身”
- 不支持 token scope
- 不支持授权边界自然语言配置
- 不支持 token 级 thinking 配置
- 不支持 token 最近使用时间统计 UI
- 不支持输出 review / policy check 闭环
- 不承诺对外暴露底层 CoT / thinking 内容

## 核心产品判断

### 1. 这不是聊天入口，而是分身推理 API

调用方传入 `messages` 不是为了复刻聊天产品，而是为了表达当前任务上下文。分身接口要做的是基于用户自身锚点与调用方上下文，输出对实践有指导价值的结果。

### 2. MVP 先只做“自己调用自己”

第一阶段不引入跨用户授权、委托调用、协作边界、第三方应用身份等复杂模型。用户只管理自己的 token，并只允许调用自己的分身。

### 3. Input cache 是关键成本前提

内部消息增强策略必须假设底层 LLM 支持 input cache。设计重点不是单纯拼 prompt，而是让稳定前缀和调用方稳定上下文尽量保持可缓存，从而降低重复调用成本。

## 对外协议

## 路径与认证

- 路径：`POST /ai/v1/chat/completions`
- 认证：`Authorization: Bearer sk-xxxx`
- `baseURL` 统一挂在 `/ai`

未来扩展路径示例：

- `POST /ai/v1/responses`
- `POST /ai/anthropic/v1/messages`（仅示意，非 MVP）

### Model 约定

`model` 固定使用：

```text
ReMi-<user_public_key>
```

例如：

```text
ReMi-7Zf2...abc
```

`model` 是本次请求的目标分身标识，也是服务端决定要打开哪个 per-user sqlite 文件的入口信息。

### OpenAI 兼容边界

MVP 对外优先兼容 OpenAI 风格 `chat/completions` 请求体，尤其是：

- `model`
- `messages`
- `stream`

但内部 runtime 不应直接绑定到 OpenAI 请求对象，而应先转换为内部统一的分身推理请求对象，再进入后续增强与生成流程。

### MVP 支持字段

MVP 仅保证支持以下请求字段：

- `model`
- `messages`
- `stream`

其余 OpenAI 风格字段在 MVP 中统一视为未支持字段，返回 `400 unsupported_parameter`。

这样可以避免实现阶段对温度、工具调用、结构化输出等能力产生不一致承诺。

## Token 模型

### 数据模型

token 不做全局集中存储，而是存储在每个用户自己的 sqlite 文件中。

建议表：`api_tokens`

字段仅保留：

- `id`
- `note`
- `created_at`

说明：

- `id` 直接作为明文 token，例如 `sk-xxxx`
- `id` 同时承担主键、唯一值、删除目标三种角色
- 不存 `owner_pub_key`，因为数据库天然按用户隔离
- 不存 `revoked_at`，因为吊销语义直接定义为删除记录
- 不存 `last_used_at`，避免在鉴权读路径上产生写副作用

建议约束：

- `id TEXT PRIMARY KEY`
- `note TEXT NOT NULL`
- `created_at TEXT NOT NULL`

### 产品语义

- 创建 token：插入一条记录
- 吊销 token：删除该条记录
- 一个用户可以拥有多个 token
- 每个 token 只用于“调用我自己的分身”

若未来需要审计最近使用时间，应通过独立 usage event 或聚合视图实现，而不是污染 token 主表。

## Token 管理接口

虽然开放推理接口走 `/ai/*`，但 token 管理仍属于 owner 自己的产品内管理能力，应继续走现有 owner API 体系。

MVP 最小补齐以下接口：

- `POST /api/:pubKey/api-tokens`
- `GET /api/:pubKey/api-tokens`
- `DELETE /api/:pubKey/api-tokens/:id`

### 鉴权原则

这些接口不是用 `Bearer sk-xxxx` 调用，而是用 owner 当前已有的本人鉴权链路调用。

也就是说：

- 用户先以现有 owner 身份进入产品
- 再在设置页创建、查看、删除自己的 API token
- API token 仅用于后续调用 `/ai/v1/chat/completions`

### 返回约定

#### 创建 token

`POST /api/:pubKey/api-tokens`

请求体：

```json
{
  "note": "Cursor local"
}
```

响应体建议：

```json
{
  "id": "sk-xxxx",
  "note": "Cursor local",
  "createdAt": "2026-03-25T00:00:00.000Z"
}
```

说明：

- `id` 就是明文 token，本次创建时完整返回
- 保持简化模型：`id = token`，后续界面或接口可以再次显示这个值；不要引入一次性 secret 语义

#### 列出 token

`GET /api/:pubKey/api-tokens`

响应体建议：

```json
{
  "items": [
    {
      "id": "sk-xxxx",
      "tokenPrefix": "sk-abc...",
      "note": "Cursor local",
      "createdAt": "2026-03-25T00:00:00.000Z"
    }
  ]
}
```

#### 删除 token

`DELETE /api/:pubKey/api-tokens/:id`

语义：直接删除该记录；删除后立即失效。

## 请求校验流程

鉴权顺序必须贴合 per-user sqlite 架构：

1. 解析 `model`
2. 从 `ReMi-<public_key>` 中提取 `public_key`
3. 打开该 `public_key` 对应的用户数据库
4. 在该数据库中查询 bearer token 是否存在
5. 存在则允许继续；不存在则拒绝

这样做的原因是：在不知道 `public_key` 之前，系统无法知道应该去哪个 sqlite 文件中查 token。

## 内部推理流程

## 总体思路

外部传入的 `messages` 不直接原样透传给底层 LLM。服务端需要先映射到内部统一输入模型，再做消息增强（message augmentation），最后将增强后的消息发送给底层模型。

增强后的调用本质上是：

```text
调用方任务上下文 + 分身身份约束 + 动态召回锚点
```

这让外部调用者得到的不是一个通用助手，而是一个带有该用户人格与记忆的专用分身接口。

## 内部统一请求模型

为避免内部 runtime 与 OpenAI `chat/completions` 输入形状耦合，MVP 需要定义一个协议中立的内部请求对象。

建议最小字段：

- `avatarTarget`
- `instructionSegments`
- `conversationTurns`
- `contentParts`
- `stream`

语义：

- `avatarTarget`：目标分身身份，例如 owner `pubKey`
- `instructionSegments`：平台级、分身级、召回级增强段
- `conversationTurns`：调用方传入的多轮对话语义
- `contentParts`：为未来兼容 richer content 留出的中立内容层
- `stream`：是否流式

OpenAI / Responses / Anthropic 适配层的职责，是把各自的请求体映射到这套内部对象；runtime 则只消费这套中立对象。

## 内部段类型与优先级

消息增强不应只描述“拼接顺序”，还需要先定义段类型及其语义优先级。

MVP 最小定义四类段：

- `platform`
- `avatar`
- `caller`
- `recall`

优先级语义：

- `platform`：最高优先级，定义 ReMi 平台级行为边界
- `avatar`：次高优先级，定义该分身的恒定身份
- `caller`：调用方本次任务上下文
- `recall`：补充性记忆上下文，不应覆盖更高优先级指令

缓存友好的排列顺序，是这些段在具体协议编码时的一种推荐实现，而不是对它们语义优先级的替代。

### 增强内容

消息增强至少包括两类内容：

- 分身身份增强：明确该接口代表的是某个用户的分身，而不是通用 AI
- Recall 增强：将本次请求召回的锚点拼接进输入上下文

### Cache 友好的消息顺序

为了最大化 input cache 收益，增强后的消息层次顺序推荐为：

1. `Stable system prefix`
2. `Stable avatar identity`
3. `Caller messages`
4. `Dynamic recall block`

其中：

- `Stable system prefix`：平台级固定 system 提示，定义分身接口的基础身份与行为原则
- `Stable avatar identity`：该用户分身的稳定身份描述，应保持短小、长期稳定
- `Caller messages`：调用方传入的原始 `messages`，尽量少改写，保留其前缀缓存价值
- `Dynamic recall block`：本次请求动态召回的锚点，推荐放在最后，避免破坏 caller messages 的缓存命中

### 为什么 dynamic recall 必须放最后

如果把 recall 区块插入到 caller messages 前面，那么每次 recall 变化都会导致后面的调用方上下文整体失去前缀缓存收益。考虑到外部调用方可能会复用很长、很稳定的上下文消息，这种损失在成本上不可接受。

因此，MVP 的关键不是只让 ReMi 自己的系统前缀可缓存，而是让：

- 稳定平台前缀
- 稳定分身身份
- 调用方稳定上下文

都尽量落在可缓存前缀内，而把最易变化的 recall 区块放在末尾。

具体编码到 OpenAI 风格 `messages` 时，也必须保持“platform/avatar 高于 caller，caller 高于 recall”的内部语义；如果某种协议无法天然表达这种分层，则应在适配层使用稳定模板进行显式包裹，而不是仅靠裸文本顺序暗示。

### Cache 友好的约束

MVP 应避免以下做法：

- 在稳定前缀中插入时间戳、请求 ID、随机文本
- 每次请求动态改写 system 模板措辞
- 将稳定身份描述与动态 recall 混写成一个大段落

MVP 应优先采用以下策略：

- 固定的 system 模板文本
- 稳定的身份描述模板与字段顺序
- 稳定的 recall block 格式
- 尽量保持 caller messages 原样

## Recall 策略

本接口继续复用 ReMi 现有的锚点召回能力，但召回结果不直接以独立字段暴露给调用方，而是作为服务端内部增强内容参与最终推理。

调用方对外看到的只是：

- 一个 `model = ReMi-<pubKey>` 的模型
- 一组 OpenAI 风格 `messages`
- 一次普通的 completion 或 stream

而“自动带上人格与记忆”是 ReMi 的内部能力，不作为外部协议负担。

## Streaming 与返回语义

### 支持模式

- `stream=false`：返回完整结果
- `stream=true`：返回 OpenAI 风格 SSE 流

`stream=true` 的适配层应在确认请求合法后立即开始 SSE 响应，不要为了等待首个上游 token 而阻塞响应头发送。

两者必须共用同一个内部 runtime，避免维护两条独立推理链路。

### 内部事件层

建议 runtime 先产出中立事件流，再由 `/ai/v1/chat/completions` 适配层将其编码为 OpenAI 风格返回。

中立事件可以包括：

- `message_start`
- `text_delta`
- `message_end`
- `usage`
- `error`

未来若需要兼容 `/responses` 或 Anthropic 风格协议，应复用该事件层，而不是重新实现分身推理流程。

### Thinking 处理

MVP 不把 thinking / CoT 作为对外协议承诺的一部分。

原因：

- 不希望被某家模型供应商的私有 reasoning 参数绑死
- CoT 可能包含敏感推理细节
- 当前 MVP 的重点是先稳定开放 assistant 输出能力

后续如需开放 thinking，应在内部事件层与授权模型成熟后再引入。

## 错误语义

MVP 需要固定最小错误语义，避免不同实现分歧：

- `model` 缺失或格式非法：`400 invalid_model`
- `public_key` 解析失败：`400 invalid_model`
- 目标用户数据库不存在：`404 model_not_found`
- bearer token 缺失或无效：`401 invalid_api_key`
- 请求包含未支持字段：`400 unsupported_parameter`
- 下游 LLM 调用失败：`502 upstream_model_error`

其中：

- `invalid_model` 应在尝试开库前完成格式校验
- `invalid_api_key` 只表示 token 不存在或不匹配目标用户库
- `model_not_found` 表示目标分身尚不存在可打开的数据空间
- 一旦 SSE 已开始，即使上游在首 token 前失败，也通过流内 error payload + `[DONE]` 收尾，而不是回退成新的 JSON 502 响应

## 架构分层建议

建议新增一层专门处理 `/ai/*` 路径的协议适配层：

- 负责解析 OpenAI 风格请求
- 负责解析 `model`
- 负责基于 per-user sqlite 完成 token 校验
- 负责将请求转换为内部统一的分身推理请求对象
- 负责将内部事件流编码为普通 JSON 或 SSE

内部推理 runtime 只关心：

- 目标分身是谁
- 调用方消息是什么
- 是否流式

它不应直接依赖某种外部 API 形状。

## MVP 范围汇总

### In Scope

- `POST /ai/v1/chat/completions`
- `model = ReMi-<user_public_key>`
- per-user sqlite token 存储与鉴权
- token 创建与删除
- message augmentation
- recall 增强
- `stream=true`
- OpenAI 风格普通响应与 SSE 响应

### Out of Scope

- `/ai/v1/responses`
- Anthropic 接口兼容
- 用户间授权
- token scope / boundary
- token 使用统计投影
- thinking 对外暴露
- response policy review

## 风险与后续演进

### 1. 全量人格访问的越界风险

MVP 默认允许“自己的 token 调自己的全量分身”，这意味着当前没有知识子集隔离。该选择是有意为之，因为第一版目标是先跑通开放接口，不先做知识沙箱。

后续若支持跨用户授权，需要新增更强的授权模型与输出 review 机制。

### 2. Cache 收益依赖底层模型实现

本设计默认假设底层 LLM 支持 input cache，且缓存策略对稳定前缀友好。如果底层供应商的缓存语义变化，增强消息顺序可能需要重新调优。

### 3. 对外兼容层的演进压力

MVP 先做 `chat/completions`，但若内部没有中立 runtime，未来扩 `/responses` 与 Anthropic 兼容时会产生较高重构成本。因此协议适配层与推理内核的边界必须从一开始就保持清晰。
