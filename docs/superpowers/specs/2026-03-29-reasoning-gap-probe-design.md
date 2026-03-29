# 推理缺口探针候选设计

## Executive Summary

- 在 `AvatarInferenceRuntime` 中新增 reasoning gap probe synthesis，把本轮推理暴露出的关键缺口问题沉淀为 probe candidates。
- probe 是旁路 side-effect，不阻塞当前回答；回答主链优先返回正常回答或保守回答。
- 首版复用现有 interview question 规范，抽出共享的 `question canonicalization` 能力，但不抽 interview 的提取职责。
- 首版不做跨请求、跨库的强 dedupe，以便先验证 probe 效果；但保留两个最小硬边界：同一 request 内 exact `canonicalQuestion` 不重复创建，且若该问题已在本轮 recall 命中的 answered anchor 中存在，则不得再生成 probe。
- rollout 采用单一 owner allowlist 灰度，rollback 只停止新增 reasoning probe，不补偿清理历史 candidate。
- 首版重点验证闭环：推理缺口 -> probe candidate -> 审批/补全 -> answered anchor -> 下次推理 recall 受益。

## 概述

当前 ReMi 已经把灵魂探针定义为“未回答的锚点”，也已经有 probe 的审批与正式存储语义，但 probe 的主要来源仍然偏向感知侧输入。推理侧虽然已经具备 decomposition、goal-based recall、sufficiency judgment 与回答边界整理能力，却还没有把“本轮回答到底缺了什么问题”稳定沉淀成新的探针候选。

本次设计要推进的不是一套阻塞式补全流程，而是让 `AvatarInferenceRuntime` 在推理过程中主动产出“关键缺口问题”的 probe candidates。当前回答仍然优先完成；若证据不足，系统先退回保守回答或边界承认，同时把本轮暴露出来的高价值缺口整理成可审批、可后续补全、可被未来推理复用的灵魂探针候选。

## 问题

- 当前推理会显式判断充分性与边界，但这些“缺什么”大多只停留在本轮回答里，没有沉淀成可追踪资产。
- 用户后续即使手动补上了某个关键问题，系统也缺少一条明确的“这个问题曾在推理中反复缺失”的来源链路。
- probe 已有产品语义与审批链路，但推理链路还没有把“回答缺口”转成 probe candidate，导致探针技术在 reasoning 侧没有真正跑起来。
- 若把“补缺口”设计成同步依赖，会阻塞本次回答，损害当前问答体验。
- 若一开始就把 dedupe 做得过重，很容易把“probe 价值不足”和“判重误伤”混在一起，反而不利于验证首版效果。

## 目标

- 在 `AvatarInferenceRuntime` 内主动产出推理缺口 probe candidates。
- probe 产出不能阻塞当前推理回答；证据不足时优先保守回答。
- probe question 必须复用现有锚点提取里的 question 规范，形成共享 canonicalization 能力，而不是新发明一套弱规则。
- 首版先跑通“推理缺口 -> probe candidate -> 审批/补全 -> 下次推理受益”的闭环。
- 为后续 dedupe、排序、命中分析保留清晰的扩展位置，但首版不把这些复杂度前置。

## 非目标

- 本轮不设计“推理时必须先补完 probe 才能回答”的同步交互。
- 本轮不把 probe 直接暴露成终端用户对话中的新 UI 协议。
- 本轮不引入正式锚点库 dedupe 拦截。
- 本轮不实现 probe 的强判重、语义聚类或统一去重策略。
- 本轮不改变现有 answered anchor 的 recall 主链。

## Alternatives

### 方案 A：同步追问缺口，再继续回答

做法是：一旦发现关键缺口，先要求用户补答或系统先补全，再继续本次推理。

不选原因：

- 会把“探针技术”错误做成同步阻塞依赖
- 明显恶化当前问答体验
- 会把 probe 价值验证和交互设计耦合在一起

### 方案 B：先做强 dedupe / 排序，再开放 probe 创建

做法是：先接入候选库、正式探针库、正式锚点库的多层 dedupe，再允许 reasoning 写 probe。

不选原因：

- 还没有真实数据就先做判重，容易误杀有价值 probe
- 会把“效果是否成立”和“判重是否正确”混在一起
- 会显著增加首版实现与验收复杂度

### 方案 C：先只做 runtime 观测，不进审批流

做法是：先把 reasoning gap 落 debug/log，之后再决定是否进审批候选库。

不选原因：

- 无法跑通真正的产品闭环
- 不能验证用户补全后未来推理是否直接受益
- 容易把 probe 长期停留在“分析产物”而不是正式技术能力

## 设计决策

| 决策项           | 选择                                              | 理由                                           |
| ---------------- | ------------------------------------------------- | ---------------------------------------------- |
| 推理缺口处理方式 | 旁路产出 probe，不阻塞回答                        | 保持当前问答可用性，避免把补缺口误做成同步依赖 |
| 触发时机         | sufficiency / boundary 判断之后，最终回答生成之前 | 此时最接近“本轮回答真正缺什么”                 |
| 产出范围         | 每轮最多 1-3 个高价值 probe                       | 降低噪音，避免把所有缺口都倒进审批流           |
| question 规范    | 复用并抽取现有锚点提取规则                        | 项目里已有稳定、自解释、可复用的 question 约束 |
| 首版去重策略     | 不做 dedupe，只做归一化                           | 先验证 probe 效果，避免判重误伤掩盖真实信号    |
| 首版用户暴露     | 不直接面向终端对话用户展示                        | 先跑通系统内部闭环，再决定交互层形态           |
| 首版失败语义     | probe 生成/落库失败不影响本次回答                 | 回答主链优先，probe 是改进资产而非阻塞依赖     |

## 核心方案

### 1. 推理缺口 probe 是旁路产物，不阻塞当前回答

当 runtime 判断当前证据不足时，系统不等待 probe 生成完成，也不要求用户立刻补答。主链仍然按当前策略完成回答：

- 若证据足够，正常回答
- 若证据不足但边界明确，输出保守回答或边界承认

与此同时，runtime 将本轮“仍然缺失、且明显影响回答盖然性的问题”整理为 probe candidates。probe 的职责不是提升本轮同步回答，而是把本轮暴露出来的高价值认知缺口沉淀下来，供后续审批、补全与未来推理复用。

这意味着一次推理可以同时产生两类结果：

- 面向当前调用方的回答
- 面向未来系统演进的 probe candidates

二者生命周期不同，失败语义也不同；probe 侧任何失败都不应污染当前回答主链。

这里必须收紧成一个最小可实现 contract：

- 先确定主回答结果，再异步尝试 probe side-effect
- probe 失败只允许“丢弃 + 记日志”，禁止触发主回答重试
- probe side-effect 不得延迟首 token
- probe side-effect 错误不得向调用方冒泡或改变回答状态码

对不同调用模式，side-effect 语义进一步固定为：

- `non-stream`：主回答结果已生成后，才允许执行 probe candidate 创建
- `stream`：首 token 发出后，probe side-effect 才可执行；若请求在首 token 前取消，则不创建 probe
- `cancel`：请求被客户端取消时，允许直接放弃尚未提交的 probe side-effect
- `timeout`：probe side-effect 自己超时只记失败，不影响主回答生命周期

### 2. probe 候选应来自“关键缺口问题”，而不是抽象缺口标签

runtime 不能只产出诸如“信息不足”“需要更多上下文”这种抽象标签。可进入 probe 候选的对象必须是稳定、可补全、可审批、可在未来再次召回的问题。

首版允许产出的 probe 类型收敛为三类：

- 事实缺口：当前回答需要某个明确事实，但没有足够证据支撑
- 判断依据缺口：要回答“我为什么会这样选/这样做”时，缺少稳定判断标准
- 术语语义缺口：当前问题涉及本体常用术语、项目名、内部概念，但缺少足够定义支撑理解

同时明确禁止以下低质量产物进入 probe：

- 纯抽象缺口标签，如“信息不足”“上下文不够”
- 对当前用户问题的机械复述
- 过宽、无法作为未来召回入口的问题
- 只能依赖当前瞬时上下文才能理解的问题

### 3. question 规范复用现有锚点提取能力，而不是新造一套 probe 规则

项目中已经存在一套更成熟的 question 约束，主要体现在 `packages/server/src/interview/prompts.ts` 与 `packages/server/src/interview/extractor.ts`：

- question 必须稳定可复用
- question 必须尽量自解释
- 必要时补足语境范围、成立条件、术语语义
- 禁止“这个/那个/刚才提到的”等离开上下文即失义的表达
- 强制统一 owner 视角主语
- 后处理只做轻量收敛，不在代码里堆复杂重写器

本轮不应为 probe 再发明一套新的、弱化版 question 规则，而应把这套能力抽成共享 `question canonicalization` contract，供 interview 锚点提取与 reasoning probe synthesis 共用。

首版共享能力包含两层：

- `displayQuestion`：给审批中心和人工审核看的自然问题文案
- `canonicalQuestion`：在共享 prompt 规则基础上，经过轻量后处理收敛出的稳定问题文案

这里的轻量后处理延续当前 `normalizeOwnerQuestion()` 的哲学：

- 统一主语口径
- 清理多余空白
- 收缩少量明显依赖上下文的表达
- 做有限的稳定表述收敛

但不在代码里引入一套大而重的程序化 question 重写器。question 质量仍以 prompt 约束为主。

共享边界必须明确切开：

| 模块                               | 负责                                                                                                         | 不负责                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| shared question canonicalization   | 输入一个已成型的问题草案，输出 `displayQuestion` / `canonicalQuestion`；复用 question 规范；做轻量后处理收敛 | 不负责 transcript extraction；不负责 probe 价值判断；不负责 candidate 选择 |
| interview-specific extraction      | 从用户消息中发现可提取锚点；决定拆分边界；决定哪些事实/判断值得提取                                          | 不负责 reasoning gap 识别                                                  |
| reasoning-specific probe synthesis | 从 sufficiency / boundary 缺口中挑选高价值问题草案；决定是否产出 probe                                       | 不负责从原始 transcript 提取锚点                                           |

### 4. 首版不做 probe dedupe，只做归一化

虽然 probe 长期一定需要考虑 dedupe，但首版刻意不把这件事前置。原因不是 dedupe 不重要，而是当前更重要的问题是：推理链路产出的 probe 是否真的有价值，是否真的会被后续补全，以及补全后是否真的能改善未来推理。

因此首版策略是：

- 允许重复 probe 出现
- 不查询 pending probe candidates 做跨请求创建拦截
- 不查询正式 probe 资产做跨请求创建拦截
- 不做跨库模糊 dedupe
- 只保证所有新 probe 都经过同一套 question canonicalization 管线

但为避免与审批层/正式层语义直接冲突，首版仍保留两个最小硬边界：

- 同一 request / turn 内，exact `canonicalQuestion` 不重复创建
- 若某个问题已在本轮 recall 命中的 answered anchor 中存在，则不得再生成 probe

这样做的好处是：

- 先观察真实缺口重复模式，而不是提前假设 dedupe 规则
- 避免把“probe 价值不高”和“判重误杀”混在一起
- 避免用新 probe 掩盖“本轮其实已经召回到答案”的实现错误
- 让后续 dedupe 设计能基于真实数据，而不是纸面猜测

首版可以接受重复探针进入审批与正式探针层，因为当前验证重点是效果闭环，不是库内洁癖。待真实使用模式清晰后，再决定 dedupe 应该放在 candidate 层、formal probe 层，还是只做排序与观测。

### 5. 后续补全应天然回流到现有 recall 主链

推理缺口 probe 的价值不在于“挂在 runtime 里”，而在于它后续能被补成 answered anchor，并自然进入未来推理。

本轮不为“reasoning 来源的 probe”单独设计特殊读取路径。闭环保持简单：

1. reasoning 产生 probe candidate
2. probe candidate 进入现有审批链路
3. 用户后续通过手动补录、访谈、阅读或其他入口补出 answer
4. 该问题转化为 answered anchor
5. 下次推理照常通过现有 recall 机制使用它

也就是说，reasoning 只是新增 probe 的来源，不改变 answered anchor 进入推理主链的既有方式。

## 数据流

```text
用户问题
  -> AvatarInferenceRuntime decomposition
  -> goal-based recall
  -> sufficiency / boundary judgment
  -> 一条主链：正常回答或保守回答
  -> 一条旁路：gap probe synthesis
       -> question canonicalization
       -> request 内 exact canonicalQuestion 去重
       -> recalled answered anchor guard
       -> create approval candidate(kind=probe, source=reasoning)
       -> 后续审批 / 补全
       -> answered anchor
       -> 未来推理 recall
```

## 具体落点

### `packages/server/src/avatar/runtime.ts`

- 在现有 runtime 编排中插入 `gap probe synthesis` 旁路阶段
- 该阶段依赖 sufficiency / boundary judgment 的缺口信息，而不反向阻塞主回答链
- stream 与 non-stream 两种调用模式都应共享相同 probe 生成语义

### reasoning prompt / orchestration 模块

- 增加一个面向 probe synthesis 的结构化输出 contract
- 让 runtime 能把“缺口”表达为有限个高价值问题，而不是自由文本标签
- prompt 规则应明确复用现有锚点 question 规范

### 共享 question canonicalization 模块

- 从现有 interview 提取链路中抽出共享的 question 规范与轻量后处理能力
- 让 interview extraction 与 reasoning probe synthesis 使用同一套基础 contract
- 保持“prompt 主导 + 轻后处理收敛”的边界，不引入大规模硬编码规则

### approval candidate 写入入口

- 新增 `reasoning` 作为 probe candidate 的来源之一，或在现有 source 体系中纳入 reasoning 来源
- probe candidate 继续走统一审批库，而不是绕过审批直接写正式层
- 所有 reasoning probe 写入仍复用现有审批网关语义

## 错误处理

- probe synthesis 失败：记录日志与指标，不影响本次回答
- canonicalization 失败：丢弃该 probe，并记录结构化错误，不影响本次回答
- candidate 创建失败：记录日志与指标，不影响本次回答
- 若本轮没有稳定高价值缺口，则允许不产出任何 probe

## 可观测性

首版最小可观测性统一包括指标、事件、阈值与排障入口四部分。

### 指标

- `probe_per_request`：每个 reasoning 请求平均创建多少 probe
- `probe_candidate_create_success_rate`：candidate 创建成功率
- `probe_drop_rate`：probe 被 guard / canonicalization / side-effect failure 丢弃的比例
- `reasoning_latency_delta_ms`：同 owner、同调用模式（stream / non-stream）下，开启 probe 功能后相对灰度前 7 日基线的回答延迟增量

### 事件

首版至少需要记录以下事件，以便后续决定 dedupe 与排序策略：

- `reasoning_probe_generated`
- `reasoning_probe_canonicalized`
- `reasoning_probe_candidate_created`
- `reasoning_probe_generation_failed`
- `reasoning_probe_candidate_create_failed`

### 排障入口

排障入口统一收敛为 reasoning runtime 日志与 approval candidate 写入日志。至少需要能按以下维度过滤：

- owner
- request / turn
- stream / non-stream
- probe 类型
- probe 最终结果（created / dropped / failed）

建议日志中同时保留以下维度：

- owner / avatar 维度
- request / turn 维度
- probe 类型（事实缺口 / 判断依据缺口 / 术语语义缺口）
- 本轮是正常回答还是保守回答

本轮不要求新增复杂 dashboard，但必须能从日志中回答：

- 每轮推理平均会产出多少 probe
- 哪类缺口最常出现
- probe 创建失败率是多少

### 人工阈值

- 若 `probe_candidate_create_success_rate < 95%`，关闭 owner 灰度
- 若 `probe_per_request > 3` 且持续异常，关闭 owner 灰度并检查 prompt 产出门槛
- 若 `reasoning_latency_delta_ms` 明显高于基线且首 token 被拖慢，视为违反非阻塞 contract，立即关闭灰度

`source=reasoning` 只用于来源标注与观测，不引入单独读取语义；正式进入 answered anchor 后，仍完全走现有 recall 主链。

## 风险与缓解

### 1. probe 数量过多，审批噪音上升

风险在于 runtime 可能把大量边缘缺口都写成 probe。首版缓解方式不是 dedupe，而是收紧产出门槛：

- 每轮最多 1-3 个 probe
- 只有显著影响当前回答盖然性的缺口才允许产出
- 纯抽象标签与机械复述禁止产出

### 2. question 质量不稳，导致 probe 不可审批或不可复用

如果新链路单独写 prompt，很容易重蹈 question 失焦、依赖上下文、术语裸奔的问题。因此本轮必须复用现有 question 规范，并把它抽成共享能力，而不是复制一份逐步漂移的文案。

### 3. 过早 dedupe 掩盖真实模式

首版若直接引入 candidate/formal probe dedupe，很可能在没有真实数据前就做出错误合并，导致我们看不见“推理到底在反复缺什么”。因此本轮明确延后 dedupe，只保留规范化与观测。

### 4. probe 创建失败污染回答链路

probe 是旁路资产，不是回答前置依赖。必须要求所有 probe 相关失败都走“观测 + 降级”，不能向上冒泡破坏主回答。

## 里程碑

### Milestone 1：跑通最小闭环

- runtime 能在证据不足时产出 1-3 个 probe 候选
- probe 进入现有审批候选库
- probe question 走共享 canonicalization 管线
- 本次回答仍正常返回或保守返回，不被 probe 阻塞
- stream 模式下首 token 不因 probe side-effect 延迟

### Milestone 2：验证补全收益

- 通过手动补录或其他入口把部分 reasoning probe 补成 answered anchor
- 验证后续相近问题下，recall 能直接受益
- 观察 probe 数量、通过率、补全率
- 至少有 1 个回归样例证明“补全前未命中 / 补全后命中”

### Milestone 3：再决定 dedupe / 排序

- 基于真实 probe 重复模式决定是否要做 candidate dedupe、formal probe dedupe 或优先级排序
- 如果进入这一阶段，再把 dedupe 从“产品假设”升级为“数据驱动策略”

## Rollout / Rollback

- rollout 采用单一 `owner allowlist` 灰度粒度，避免同时引入 avatar / 百分比等多种灰度口径
- 首阶段仅对少量 owner 开启 reasoning probe creation，比较开启前后 `probe_per_request`、成功率与延迟增量
- 若 probe 质量或数量明显失控，可关闭该 owner 的 reasoning probe 创建，但不影响原有推理回答链
- rollback 的边界是“停止新增 reasoning probe”，而不是清理已经写入的 candidate；历史 candidate 不做补偿删除，避免回退逻辑过重
- 任意回退都不得恢复绕过审批直接写正式层的路径

## 验收标准

- 正例：当问题确实缺少关键事实/判断依据/术语语义，runtime 可产出 1-3 个 probe candidates
- 反例：当缺口只影响措辞细节、不影响回答方向时，不得生成 probe
- 反例：当问题已在本轮 recall 命中的 answered anchor 中存在时，不得再生成 probe
- 同一问题草案经过共享 canonicalization 后，在 interview / reasoning 两条链路上应得到相同 `canonicalQuestion`
- `stream` 模式下，首 token 的发出不依赖 probe candidate 创建成功；probe 失败不得改变回答状态码或最终回答文本
- reasoning 产生的 probe 会进入统一审批候选库，不会绕过审批直接写正式层
- 用户后续把相关问题补成 answered anchor 后，至少有一个回归样例可证明下次推理能经现有 recall 主链直接命中并受益
- 首版不做跨请求、跨库的强 dedupe，只保留 request 内 exact 去重与 recalled answered anchor guard
