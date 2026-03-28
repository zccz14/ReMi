# 推理运行时统一与会话层解耦设计

## 概述

当前仓库中同时存在两套相近但不统一的推理能力：

- 一套是 `ReasoningEngine` 驱动的平台内 reasoning 会话链路
- 一套是 `AvatarInferenceRuntime` 驱动的 OpenAI 兼容分身推理链路

两者都在做“基于本体信息、调用方上下文与锚点召回生成回答”，但它们在入口语义、prompt 组织方式、debug 产物与编排能力上逐步分叉，已经开始带来以下问题：

- 同样是推理，却存在两条主流程，后续继续增强时需要双处维护
- `ReasoningEngine` 有更强的 decomposition / sufficiency / debug artifact 能力，但这些能力没有进入 OpenAI 兼容主链
- `AvatarInferenceRuntime` 已经建立了较好的协议中立输入模型与 cache-friendly 下游消息骨架，但平台内 reasoning route 没有复用这套结构
- 平台内会话层职责（历史消息、列表、已读、attest）与推理内核职责混在一起，导致边界不够清晰

本设计的目标不是再做第三套抽象，而是把推理能力彻底收敛到 `AvatarInferenceRuntime`，同时保留 `/:pubKey/reasoning/message` 这类平台会话入口，但将其降级为“会话应用适配层”。

## 背景问题

### 1. 两套推理主链长期并存不可维护

`ReasoningEngine` 与 `AvatarInferenceRuntime` 都在承担推理核心职责：理解问题、组织上下文、召回锚点、生成回答。它们若继续并存，后续任何关于本体认知、召回质量、提示词结构、debug 可观测性的改进，都需要双处同步，极易漂移。

### 2. 平台内会话语义与开放推理语义被混淆

平台内 reasoning route 可以读取某个 visitor 的历史对话，这是产品会话层能力；OpenAI 兼容接口的 caller context 则来自调用方显式提交的 `messages`。两者都是“上下文”，但来源不同、边界不同，不能简单混为一谈。

如果把“服务端持久化聊天历史”直接定义为推理内核的通用前提，就会错误地污染 OpenAI 兼容链路；反过来，如果完全不承认平台内会话层的存在，又会损失产品内多轮对话能力。

### 3. `ReasoningEngine` 的编排增强还没有进入统一 runtime

最近一轮增强已让 `ReasoningEngine` 具备：

- decomposition
- goal-based recall assessment
- sufficiency judgment
- missing information 注入
- debug artifact 落盘

但 OpenAI 兼容主链目前仍主要停留在：

- 组装 platform / avatar / caller / recall
- 将 recall 以尾部 assistant message 的形式追加

这意味着最强的推理能力没有落在未来的统一入口上。

### 4. 调试视角仍然围绕“单个 final prompt”

`ReasoningEngine` 现有 debug 样本以 `final-prompt.md` 为中心，这对排查最终生成问题有价值，但随着 unified runtime 引入更多中间 LLM turn，仅看单个 final prompt 已不足以解释整个推理过程。

调试对象应该从“一个 prompt”升级为“runtime 内部的 LLM turn 序列 + 最终下游 messages”。

## 目标

- 以 `AvatarInferenceRuntime` 作为唯一推理主链，吸收 `ReasoningEngine` 的认知编排能力
- 保留 `/:pubKey/reasoning/message` 路径，但将其改造成会话应用适配层，而不是独立推理引擎入口
- 保留 `/ai/v1/chat/completions` 作为 OpenAI 兼容协议适配层，并与前者共用同一推理内核
- 统一下游消息骨架，继续沿用 `platform + avatar + caller system`、caller messages、dynamic recall tail 的结构
- 将 debug artifact 升级为“按 LLM turn 展开 + 最终 messages 双视图”的调试体系
- 让迁移过程在 AI agent 无记忆、中途交接的情况下仍可继续推进

## 非目标

- 本轮不做对话摘要压缩
- 本轮不修改对话表结构来持久化 conversation summary
- 本轮不保留长期双跑或 runtime feature flag
- 本轮不把平台内会话接口改成 HTTP 回环调用 `/ai/v1/chat/completions`
- 本轮不额外设计新的对外协议；OpenAI 兼容接口仍以 `chat/completions` 为唯一对外推理协议

## 设计决策

| 决策项               | 选择                                     | 理由                                                           |
| -------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| 唯一推理主链         | `AvatarInferenceRuntime`                 | 其输入模型更协议中立，且已具备稳定下游消息骨架                 |
| reasoning route 角色 | 会话应用适配层                           | 保留产品多轮对话能力，但剥离推理内核职责                       |
| 共享方式             | 共用内部 service/runtime，不做 HTTP 回环 | 避免重复编解码、绕路鉴权与多余复杂度                           |
| 迁移方式             | 直接收敛式迁移（先并入、后删除）         | 用户明确要求最终干净删除 `ReasoningEngine`                     |
| 可恢复性             | 依赖设计文档、阶段检查点、handoff 状态   | 用户要的是 AI agent 无记忆情况下仍可续做，而不是代码层回滚开关 |
| 下游 prompt 结构     | 保持现有 runtime messages 骨架           | 避免破坏 cache-friendly 排列与既有协议语义                     |
| debug 组织方式       | 以 LLM turn 序列组织                     | 中间产物本身也是对 LLM 的调用，应单独暴露 prompt/response      |

## 核心架构

### 调整前

```text
平台内 reasoning route
  -> ReasoningEngine
  -> 自己做 recall / generation / artifact

OpenAI chat/completions route
  -> AvatarInferenceRuntime
  -> 自己做 caller context + recall tail
```

### 调整后

```text
平台内 reasoning route
  -> 会话层消息组织
  -> Unified AvatarInferenceRuntime

OpenAI chat/completions route
  -> 协议适配
  -> Unified AvatarInferenceRuntime
```

### 三层边界

#### 1. Conversation App Layer

代表入口：`POST /:pubKey/reasoning/message`

职责：

- 读取某个会话的历史消息
- 决定传入多少轮对话上下文
- 组织 caller `system` / `user` / `assistant` messages
- 保存 user / assistant message
- 处理 read / attest / list / integrity 等会话能力

不负责：

- decomposition
- goal recall
- sufficiency judgment
- final generation prompt 编排

#### 2. Protocol Adapter Layer

代表入口：`POST /ai/v1/chat/completions`

职责：

- 解析 OpenAI 风格请求
- 校验 model / token / stream
- 将 OpenAI `messages` 映射为内部 request
- 将 runtime 输出编码为 OpenAI 风格 JSON 或 SSE

不负责：

- 推理策略本身
- 本体认知编排
- recall / sufficiency 的业务决策

#### 3. Unified Inference Layer

唯一宿主：`AvatarInferenceRuntime`

职责：

- 合成 platform / avatar / caller system
- 承接 caller context
- 执行 decomposition
- 执行 goal-based recall
- 执行 sufficiency assessment
- 生成 dynamic recall additions
- 组装最终下游 messages
- 产出 debug artifact
- 执行 non-stream / stream 生成

## 统一后的下游消息骨架

本轮不推翻 `AvatarInferenceRuntime` 已建立的消息层次，而是在其内部增强推理能力。

### 保留的骨架

```text
[system]
  platform + avatar + caller system

[assistant/user/...]
  caller context messages

[assistant]
  dynamic recall additions
```

对应当前实现语义：

- `platform`：平台级固定边界
- `avatar`：本体公开身份与稳定身份描述
- `caller system`：调用方显式提供或会话层补充的系统级上下文
- `caller context messages`：本次请求的 user / assistant turns
- `dynamic recall additions`：本次请求动态召回出的证据、缺口与边界

### 为什么不改成“大一统单 prompt”

统一 runtime 的真实下游输入是 `messages` 数组，而不是单个大 system prompt。若为了吸收 `ReasoningEngine` 而退回到“大一统文本 prompt”，会丢失以下优势：

- 现有 caller messages 结构与外部协议一致
- cache-friendly 前缀更稳定
- caller system 与 caller context 的来源边界更清晰
- debug 更贴近真实下游输入

因此，本轮统一的是“推理能力”，不是“把所有东西重新塞回一个字符串”。

## `ReasoningEngine` 的吸收策略

### 最终原则

本轮结束后，仓库里不允许继续存在第二套推理主流程。唯一推理主流程是 `AvatarInferenceRuntime`。

### 吸收方式

不把 `ReasoningEngine` 类原样搬运，而是按能力拆分后并入 unified runtime。

#### 应吸收进 unified runtime 的能力

- decomposition 主流程
- default goals / temporal goal 判定
- goal-based recall 编排
- sufficiency judgment
- missing information 汇总
- final recall tail 生成约束
- debug artifact 写入时机与摘要

#### 可作为基础模块保留的零件

这些能力可以在文件层面保留为可复用模块，但它们不再组成一条独立推理主链：

- `goalBasedRecall`
- decomposition / judgment prompt builder
- debug artifact writer
- goal status / missing info 归一化纯函数

这里“保留”指保留为基础能力模块，而不是保留 `ReasoningEngine` 这条旧入口链路。

### `ReasoningEngine` 的删除条件

只有在以下条件都满足时，才允许删除旧代码：

- `/:pubKey/reasoning/message` 已调用 unified runtime
- `/ai/v1/chat/completions` 已调用 unified runtime
- decomposition / recall / sufficiency / final generation / artifact 全部由 unified runtime 完成
- debug artifact 已从 unified runtime 产出
- `ReasoningEngine` 已无任何生产引用与测试依赖

满足后，删除：

- `packages/server/src/reasoning/engine.ts`
- 仅服务于该旧主链的类型和测试
- 任何旧调用点与 imports

## `/:pubKey/reasoning/message` 的改造方向

保留外部路径与产品职责，但重新定义内部职责。

### 迁移后职责

- 从消息库读取最近若干轮历史消息
- 原样保留历史中的 `assistant` / `user` turns
- 只在必要时补充 caller `system` message
- 将这些消息组织成 unified runtime 所需的 caller context
- 调用共享 inference service
- 将结果持久化回消息库

### 本轮明确不做

- 不做对话摘要压缩
- 不修改消息表结构以支持 summary 持久化
- 不让 route 自己重做 recall / sufficiency / generation 编排

### 当前决定

本轮先按“原样保留历史 turns，只额外补 caller system”的方式迁移。摘要压缩另开课题。

## Prompt / Recall 增强如何映射到 unified runtime

用户对现有 final prompt 提出的 4 点反馈，在 unified runtime 中的落点如下。

### 1. 本体描述不清楚

落点：`avatar` segment

应显式包含：

- owner public key
- owner display name
- owner bio
- 必要的身份边界描述

### 2. 提问者描述不清楚

落点：`caller system` supplement

若当前入口能够无歧义读取 caller 的公开资料，则可补充：

- caller public key
- caller display name
- caller bio

若入口拿不到，则显式为空，不允许编造。

### 3. 缺少聊天记录上下文

落点：`caller context messages`

这里不再被表述为“最近聊天记录是推理内核的通用依赖”，而是被建模为“由入口按其能力提供的 caller context”：

- reasoning route：来自平台内消息历史
- OpenAI 接口：来自调用方显式传入的 `messages`

### 4. 锚点 ID 是噪音

该项优先级下降。本轮允许保留 anchor ID，不把它作为必须清理项。优先先解决 identity、caller、message structure 等真正影响质量的部分。

## Debug Artifact 设计

### 核心原则

debug artifact 不再只围绕一个 `final prompt` 组织，而是围绕 unified runtime 内部的 LLM turn 序列组织。

原因是：

- decomposition 是一次 LLM 调用
- sufficiency judgment / recall rounds 是一组 LLM 调用
- final generation 也是一次 LLM 调用

这些中间产物本质上都是对 LLM 的调用，应当被独立暴露出来。

### 命名约定

每个关键 LLM turn 使用以下文件对展开：

- `<turn-id>-prompt.md`
- `<turn-id>-prompt.json`
- `<turn-id>-response.txt`
- `<turn-id>-response.json`（若该 turn 响应可结构化）

示例：

- `01-decomposition-prompt.md`
- `01-decomposition-prompt.json`
- `01-decomposition-response.txt`
- `01-decomposition-response.json`
- `02-sufficiency-round-1-prompt.md`
- `02-sufficiency-round-1-response.json`
- `03-final-generation-prompt.md`
- `03-final-generation-messages.json`
- `03-final-generation-response.txt`

### 最终生成的双视图

最终生成阶段额外保留两份重点调试视图：

- `final-messages.json`
  - 机器可读
  - 保存真实发给下游模型的 `messages`
- `final-prompt.md`
  - 人类可读
  - 用以下形式展开：

```md
[role: system]
...

[role: assistant]
...

[role: user]
...
```

这样既能忠实反映真实输入，又比 JSON 更便于人工审查。

### 聚合视图

除了 turn 级文件，还应保留：

- `summary.json`
- `recall-rounds.json`

用于快速定位本次推理的整体状态。

## 迁移可恢复性设计

这里的“可恢复”不是指每个 commit 都必须可运行，也不是指 runtime 层必须具备随时切回旧链路的开关。

这里的真正要求是：

- 即使 AI agent 失忆
- 即使中途交接到新的 agent
- 仍然可以依靠设计文档、阶段检查点与上下文记录继续推进迁移

### 因此本轮采用的恢复策略是

- 不做 feature flag
- 不做长期双跑
- 不要求每次中间态都完全对外可用
- 但要求每个阶段都明确记录：
  - 当前已经并入 unified runtime 的能力
  - 仍留在旧链路的能力
  - 下一步接线点
  - 删除旧代码的前置条件

### 阶段检查点要求

迁移设计与后续 plan 必须按阶段定义清楚：

1. 哪些能力先被移入 unified runtime
2. 哪些入口随后切到 unified runtime
3. 哪些 debug artifact 在何阶段完成迁移
4. 何时开始移除旧测试
5. 何时删除 `ReasoningEngine`

这样中途停下时，后续 agent 无需依赖短期记忆，只需读取 spec、plan、`.legion/context.md`、`.legion/tasks.md` 即可恢复工作。

## 风险与应对

### 风险 1：统一 runtime 过程中破坏既有 caller/recall 消息顺序

应对：

- 将现有 OpenAI integration test 中对消息顺序的断言视为强约束
- 任何能力吸收都不得破坏 `system -> caller messages -> recall tail` 的骨架

### 风险 2：在迁移期间提前删除旧代码，导致失去对照物

应对：

- 在新链路未验证前，不删除 `ReasoningEngine`
- 直到 unified runtime 已完整承接能力并完成验证，再进行最终删除

### 风险 3：debug artifact 在统一过程中反而变得更难读

应对：

- 所有 turn 都同时提供 machine-readable 与 human-readable 视图
- 最终 generation 额外保留展开式 `final-prompt.md`

### 风险 4：平台内会话层继续偷偷承担推理逻辑

应对：

- 在 implementation plan 中显式列出 route 层允许与禁止承担的职责
- 以“是否直接做 decomposition / recall / sufficiency”为判断标准，防止旧逻辑残留

## 验收标准

- `AvatarInferenceRuntime` 成为唯一推理主链
- `/:pubKey/reasoning/message` 与 `/ai/v1/chat/completions` 共用同一推理内核
- unified runtime 已承接 decomposition、goal recall、sufficiency、final generation、artifact
- 最终 debug artifact 既能展示 turn 级 prompt/response，也能展示最终完整 messages
- `ReasoningEngine` 在新链路验证完成后被彻底删除，无残留生产引用

## 后续计划入口

本 spec 审核通过后，下一步应编写 implementation plan，重点覆盖：

- `ReasoningEngine` 能力吸收顺序
- unified runtime 的中间接口与模块拆分
- route 切换顺序
- debug artifact 文件迁移顺序
- 最终删除旧代码的检查点
