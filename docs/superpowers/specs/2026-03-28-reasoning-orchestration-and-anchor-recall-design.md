# 推理编排与锚点召回增强设计

## 概述

当前推理链路已经具备统一 recall runtime 的基础能力，但仍然偏向“先召回一批锚点，再直接生成回复”。这套流程的主要问题不是能否跑通，而是中间缺少一层结构化的推理编排协议，导致系统在以下方面仍然偏弱：

- 用户问题进入后，没有先被拆成“回答这类问题到底需要哪些信息”的目标集合
- Recall loop 主要产出锚点集合，较少显式表达“已知什么、缺什么、为什么还不能下结论”
- 最终生成 prompt 缺少当前时间与锚点更新时间，难以感知信息是否可能过时
- 当补召回已经没有增量信息时，系统仍可能继续机械迭代
- 最近一次推理过程中实际使用的 prompt 与生成结果缺少稳定、可复制的调试落点

本设计聚焦推理阶段的召回编排与提示词协议升级。目标不是单纯润色文案，而是把“召回什么”“为什么继续召回”“何时停止”“哪些缺口必须保留到最终生成阶段”都纳入统一编排。

## 背景问题

### 1. 缺少 Query 分解层

当前推理阶段会把用户消息较直接地送入 recall / generation 流程，但很多问题天然包含多个子任务，例如：

- 我是谁、我平时会怎么说
- 提问者是谁、和我什么关系、边界在哪里
- 回答当前问题真正依赖哪些原则、偏好、经历、事实
- 这些判断是否受时间影响，已有锚点会不会过时

如果不先把问题拆成目标集合，Recall loop 就容易只围绕表面话题做近义搜索，而忽略“回答方式”“关系边界”“时间有效性”这些同样关键的信息需求。

### 2. Recall 输出过于扁平

当前 recall runtime 的主要产物还是锚点集合。即便内部做了充分性判断，最终 generation 阶段通常也只继承“召回到了哪些锚点”，而没有完整继承：

- 哪些目标已经满足
- 哪些关键信息仍然缺失
- 本轮为何停止继续召回
- 哪些推理只是一条暂时的逻辑链，而不是确定事实

结果是最终生成模型虽然拿到了锚点，却不知道哪些地方其实仍然不确定，容易把“推断”说成“已知事实”。

### 3. 时间语境缺失

当前生成 prompt 未显式注入当前时间，锚点列表也未稳定暴露更新时间。对于具有明显时效性的内容，例如“最近在做什么”“现在对某件事的态度如何”，模型缺少判断信息陈旧性的上下文。

### 4. Recall 无增益时缺少提前停止

当前 Recall loop 的停止条件主要是 sufficient、query 用尽或达到轮次上限。若某一轮没有带来任何新增锚点，或虽然召回到新锚点但没有减少任何 missing 信息，继续迭代通常不会带来真正收益，反而会增加等待时间与额外调用成本。

### 5. 缺少稳定的推理样本落盘

当前若要调查最近一次推理具体用了什么 prompt、做了多少轮 recall、最终生成了什么回复，通常需要临时打日志或读运行输出。缺少一个固定目录来保存“最近一次推理样本”，不利于手工复制与离线分析。

## 目标

- 在推理入口新增 Query 分解阶段，先把用户问题拆成结构化 answering plan
- 让 Recall loop 输出的不只是锚点集合，还包括子目标级别的 known / missing / sufficient 状态与 reasoning chain
- 在最终 generation prompt 中显式注入当前时间与每条锚点的更新时间
- 当补召回没有新增有效信息时提前终止 recall，而不是机械跑满轮数
- 将缺失信息与逻辑链路一并注入最终 generation prompt，帮助模型明确知道“哪些知道，哪些不知道”
- 将最近一次推理过程样本稳定写入仓库内固定调试目录，便于复制分析

## 非目标

- 本轮不做前端调试页
- 本轮不做多次推理历史归档，只保留最近一次样本
- 本轮不引入新的数据库字段持久化 decomposition、reasoning chain 或 round summaries
- 本轮不先做复杂的锚点标签体系（如 profile / preference / temporal tag），先通过编排协议和 prompt 结构约束提升效果

## 设计决策

| 决策项           | 选择                                              | 理由                                         |
| ---------------- | ------------------------------------------------- | -------------------------------------------- |
| 推理主流程       | decomposition -> recall -> constrained generation | 先定义信息需求，再按需求召回，最后受约束生成 |
| 时间语境         | 同时注入 `currentTime` 与 anchor `updatedAt`      | 让模型显式感知信息时效性                     |
| Recall 提前停止  | 根据增量锚点与 missing 缩减情况判定               | 避免无增益补召回                             |
| 最终 prompt 结构 | 同时注入 evidence 与 missing                      | 避免模型把缺口脑补成事实                     |
| 可观测性         | 固定目录 `debug/reasoning-last/` 覆盖最近一次     | 使用简单，可直接复制调查                     |
| 调试持久化范围   | 文件落盘，不落库                                  | 降低侵入性，先满足排障需求                   |

## 核心流程

### 调整前

```text
用户提问
  -> recall loop
  -> 生成回复
```

### 调整后

```text
用户提问
  -> 生成 currentTime
  -> Query decomposition
  -> goal-driven recall assessment
  -> 如锚点数较少则走 full-injection，否则进入 recall loop
  -> 判断是否 sufficient / no-gain / max-rounds
  -> 组装 final generation prompt
  -> 流式生成回复
  -> 写入最近一次推理样本到 debug/reasoning-last/
```

### 全局不变式

无论本次请求最终走 `full-injection` 还是 `recall-loop`，都必须遵循同一条高层编排骨架：

1. 先做 decomposition
2. 再做 recall assessment
3. 最后做 constrained generation

也就是说，小锚点集合场景可以跳过多轮 recall loop，但不能跳过 decomposition、goalStatus 组装、missing 注入、`currentTime` 注入与最终 prompt 边界约束。区别只在于：

- `full-injection`：直接把当前全部锚点作为证据集，`rounds = 0`
- `recall-loop`：继续通过 query 改写和多轮召回补全证据集

## Query Decomposition

### 目标

在 recall 之前，先把用户问题拆成“为了回答这个问题，系统需要哪些类型的信息”。decomposition 的作用不是直接生成答案，而是定义召回阶段需要满足的目标集合与验收边界。

### 标准子目标

每次推理至少要考虑以下 3 个必选目标：

1. `identity_style`：本体会以什么身份、语气、表达方式来回答
2. `relationship_boundary`：提问者与本体是什么关系、是否存在沟通边界或保留范围
3. `domain_answer`：回答当前问题所需的事实、经历、偏好、原则与判断

如果问题明显含有时间性或“最近/现在/目前/变化/是否还成立”等语义，还需要额外考虑：

4. `temporal_validity`：现有锚点是否可能过时、是否需要优先检索近期信息

当用户问题本身带有明显时间要求时，`temporal_validity` 不再只是可选观察项，而应被视为 required blocker：系统可以继续回答已知部分，但必须显式标注“时间有效性不足”，不得把旧锚点包装成当前确定结论。

### 输出结构

建议 decomposition 输出稳定 JSON 结构，例如：

```json
{
  "userQuery": "原始问题",
  "currentTime": "2026-03-28T12:34:56+08:00",
  "answerGoals": [
    {
      "id": "identity_style",
      "goal": "判断本体会以什么身份、语气、表达习惯来回答",
      "required": true
    },
    {
      "id": "relationship_boundary",
      "goal": "判断提问者与本体的关系、沟通边界、可说与不可说的范围",
      "required": true
    },
    {
      "id": "domain_answer",
      "goal": "找到支撑本体回答该问题所需的事实、经验、偏好、原则",
      "required": true
    },
    {
      "id": "temporal_validity",
      "goal": "判断回答依赖的信息是否受时间影响、是否可能过期",
      "required": false
    }
  ],
  "successCriteria": ["能说明哪些结论有锚点支撑", "能说明哪些关键信息仍然缺失", "缺失时不瞎编"]
}
```

### 约束

- decomposition 只负责拆解信息需求，不负责替代最终回答
- decomposition 产出的 reasoning 不能作为事实证据；事实仍必须来自锚点或明确缺失说明
- decomposition 结果应保持稳定、可调试，便于落盘到样本目录

### 解析失败回退

如果 decomposition 模型输出无法稳定解析，则不应直接中断整次推理。回退策略应固定为：

- 使用默认 goals：`identity_style`、`relationship_boundary`、`domain_answer`
- 若原始 query 含显式时间词，再额外补 `temporal_validity`
- 将本次停止原因或降级原因记录进调试样本摘要，便于后续调查

## Goal-Driven Recall

### Recall 目标

Recall loop 不再只回答“当前锚点够不够”，而要对 decomposition 中的每个子目标做显式评估：

- 已知什么（known）
- 缺什么（missing）
- 当前是否充分（sufficient）
- 若不充分，下一轮该检索什么（nextQuery）

### Judgment 输出结构

建议每轮 judgment 的最小输出结构为：

```json
{
  "sufficient": false,
  "goalStatus": [
    {
      "goalId": "identity_style",
      "known": ["我偏好直接、克制的表达"],
      "missing": [],
      "sufficient": true
    },
    {
      "goalId": "domain_answer",
      "known": ["我倾向先做小规模验证再扩大投入"],
      "missing": ["我对这个具体话题有没有近期态度变化"],
      "sufficient": false
    }
  ],
  "nextQuery": "我最近对这个话题的最新判断和变化",
  "reasoningChain": [
    "用户问的是建议，不只是事实回忆",
    "已有原则类锚点能支撑部分回答",
    "但缺少近期态度，存在时间漂移风险"
  ],
  "narrative": "我在想你最近有没有表达过更接近这个问题的态度。"
}
```

### 可比较的最小 schema

“是否有增益”不能依赖自由文本 `missing` 比较。为保证 runtime 可稳定比较，`goalStatus` 需要包含 machine-comparable 结构，建议至少增加：

```json
{
  "goalId": "domain_answer",
  "sufficient": false,
  "knownAnchorIds": ["a1", "a2"],
  "missingKeys": ["recent-position", "visitor-relationship"]
}
```

其中：

- `knownAnchorIds` 用于把 known 状态与真实证据绑定，避免只剩自然语言摘要
- `missingKeys` 必须来自受控的小词表或稳定标识符，而不是自由文本描述
- 面向人类阅读的 `known` / `missing` 摘要仍可保留，但 runtime 判断增益时应只比较 `knownAnchorIds` 与 `missingKeys`

`missingKeys` 的词表归运行时协议所有，而不是交给模型自由发明。第一版建议只允许以下稳定键：

- `identity-unknown`
- `style-unknown`
- `visitor-relationship`
- `visitor-boundary`
- `domain-fact-missing`
- `domain-preference-missing`
- `recent-position`
- `time-validity-uncertain`
- `unassessed-required-goal`
- `other`

对于模型返回的未知 key，runtime 必须做确定性归一化：

- 若能映射到已知同义键，则归一化到对应稳定键
- 若不能映射，则统一降级为 `other`

`no-missing-reduced` 的判定只能基于归一化后的 key 集合。

这样可以避免“同义改写导致误判为有增益或无增益”。

### Runtime 责任与模型责任分离

是否“有增益”不能完全交给模型主观判断，需要 runtime 与 judgment 共同决定：

- judgment 负责提供 `goalStatus`、`nextQuery` 与 reasoning chain
- runtime 负责比较本轮与上一轮的召回结果和 missing 集合变化，判定是否真的有新增有效信息

如果 judgment 输出缺少必要字段、goalId 不存在、`nextQuery` 无法使用，runtime 必须走确定性回退，而不是把不完整结果继续向下传递。

此外，最终 `sufficient` 不应直接信任模型输出，而应由 runtime 基于归一化后的 required-goal 状态重新计算：只有所有 required goals 都 `sufficient = true` 时，整轮结果才可视为 `sufficient = true`。

## 无增益提前停止

### 停止信号

Recall loop 增加显式的 `stoppedBecause`，建议支持以下枚举值：

- `sufficient`
- `no-new-anchors`
- `no-missing-reduced`
- `empty-next-query`
- `parse-failure`
- `max-rounds`

### 触发条件

满足任一条件即可提前终止：

1. 本轮没有新增 anchor
2. 本轮新增了 anchor，但没有减少任何 required goal 的 missing
3. judgment 没有给出有效 `nextQuery`
4. 所有 required goal 已经 sufficient
5. 达到最大轮数

这意味着：

- Recall 可以在“不完全充分”的情况下结束
- 结束时必须把 remaining missing 明确传给最终生成 prompt
- 最终回答应体现“我目前知道到哪里、不知道到哪里”，而不是把 recall 停止误写成“信息完整”

### Parse / Query 失败回退

为避免结构化协议在模型输出不稳定时拖垮主流程，需定义以下回退：

- judgment parse 失败：可重试一次；若仍失败，则以 `stoppedBecause = parse-failure` 结束 recall
- `nextQuery` 为空、重复、或与上一轮实质相同：以 `empty-next-query` 结束 recall
- 某个 `goalId` 缺失或不合法：runtime 必须回填该 required goal 的标准状态，至少写为 `sufficient = false` 且 `missingKeys = ["unassessed-required-goal"]`；不能简单忽略后继续

这条规则的目的，是防止模型遗漏 required goal 时让整次请求看起来“比实际更完整”。

## 时间语境

### 当前时间

推理入口需要生成稳定的 `currentTime`，并注入到：

- decomposition prompt
- recall judgment prompt
- final generation prompt
- 最近一次推理样本摘要

运行时内部可继续使用数值时间戳；在 prompt builder 边界统一格式化为 ISO-8601 字符串。这样既保持内部处理简单，也保证提示词与调试样本中的时间表现一致。

### 锚点更新时间

最终注入 generation prompt 的每条锚点都应附带 `updatedAt`，建议格式为：

```text
- Q: 我最近在忙什么？
  A: 最近在推进独立开发和路演准备
  UpdatedAt: 2026-03-27T21:13:08+08:00
```

设计意图：

- 让模型识别“当前时间”和“最后更新时间”的差值
- 对“最近”“现在”“还是否如此”这类问题采用更保守的表达
- 不要求模型做复杂日期推导，但要求它知道哪些信息可能过时

## 最终 Generation Prompt

### 核心原则

最终 prompt 不能只喂证据，也必须喂缺口。模型必须同时知道：

- 哪些结论已有锚点支撑
- 哪些目标仍缺少信息
- 哪些内容只是 recall 阶段的逻辑链路，而不是事实本身

因此最终 prompt 需要在概念上把输入分成两条严格分离的通道：

- `Evidence`：锚点及其 ID、问答内容、更新时间。这是唯一允许支撑事实性判断的来源。
- `Non-evidence reasoning`：decomposition、goalStatus 摘要、reasoning chain、停止原因。这些只用于组织回答边界，不能被当作新的事实来源。

### 固定结构

建议 generation prompt 按以下顺序组织：

1. 当前时间
2. 用户问题
3. 回答目标分解
4. 已知锚点（含更新时间）
5. 仍然缺失的信息
6. 推理链路与回答约束

### 关键硬规则

必须显式加入以下规则：

1. 如果某个结论只出现在 reasoning chain 中、但没有 anchor 支撑，不能把它表述成确定事实
2. 如果 required goal 存在 missing，必须承认边界，不得脑补填空
3. 如果 `temporal_validity` 不充分，应优先使用保守措辞，例如“基于目前已知锚点”“我目前只知道”
4. 宁可明确说不知道，也不要把推断包装成回忆或既有立场
5. 任何 factual claim 都必须可回溯到 `Evidence` 中的 anchor，而不能仅来自 `Non-evidence reasoning`

### Missing 注入的价值

注入 missing 的目的不是让模型复读“我不知道”，而是让它在回答时主动规避越界表达。例如：

- 可以先回答已知部分
- 再说明剩余缺口
- 对无法确定的部分保持保守

这样回答会更像“有边界感的分身”，而不是“拿少量线索强行补全”。

## 可观测性

### 固定目录

最近一次推理样本写入固定目录：

- `debug/reasoning-last/`

该目录始终覆盖最近一次，不做历史归档。用户若要调查，只需复制整个目录出来分析。

为避免并发请求交叉覆盖，写入流程必须原子化：

1. 先写入请求级临时目录，例如 `debug/.reasoning-last-tmp-<requestId>/`
2. 所有文件写完后，再一次性 rename / replace 到 `debug/reasoning-last/`
3. 只有成功完成整次替换后，才视为最近一次样本可读

### 建议文件结构

- `debug/reasoning-last/request.json`
- `debug/reasoning-last/decomposition.json`
- `debug/reasoning-last/recall-rounds.json`
- `debug/reasoning-last/final-prompt.md`
- `debug/reasoning-last/response.txt`
- `debug/reasoning-last/summary.json`

其中 `summary.json` 至少包含：

- `currentTime`
- `userQuery`
- `rounds`
- `stoppedBecause`
- `finalAnchorIds`
- `hasUnsatisfiedRequiredGoal`

`recall-rounds.json` 的稳定 schema 也应在本轮定下最小集合，避免后续调试文件漂移。每轮至少包含：

- `round`
- `query`
- `newAnchorIds`
- `allAnchorIds`
- `normalizedGoalStatus`
- `stoppedCandidate`

### 调试边界

- 本轮只落盘最近一次样本，不做按时间归档
- 这些 artifact 主要用于开发与人工调查，不作为业务协议的一部分
- 默认应仅在本地开发环境或显式开启的受控环境中写入；是否启用必须由明确开关控制，而不是默认在所有部署环境开启
- `roundSummaries` 虽可作为 runtime 返回值的一部分，但写入调试目录时应视为调试契约的一部分，需保持字段语义稳定

## 模块改动建议

### `packages/server/src/reasoning/engine.ts`

- 串起 decomposition -> recall -> generation -> debug artifact 落盘主流程
- 负责生成 `currentTime`
- 负责把 recall 的 `goalStatus`、`reasoningChain`、`stoppedBecause` 传给最终 prompt builder
- 即使走 `full-injection`，也必须补齐 decomposition、goalStatus 与 missing 汇总

### `packages/server/src/reasoning/prompts.ts`

- 从单一 avatar prompt 升级为多类 prompt builder：
  - decomposition prompt
  - recall judgment prompt
  - final generation prompt
- 负责定义固定的 prompt 结构，而不是让调用方拼字符串

### `packages/server/src/recall/goal-based-recall.ts`

- 保留统一 recall runtime
- 扩展结果结构，建议新增：
  - `goalStatus`
  - `reasoningChain`
  - `stoppedBecause`
  - `roundSummaries`
- 在 runtime 内实现“无增益提前停止”的判定逻辑
- 对 parse failure、无效 goalId、空或重复 `nextQuery` 提供确定性回退

### `packages/server/src/reasoning/debug-artifact.ts`

- 新增一个小模块负责把最近一次推理样本写入 `debug/reasoning-last/`
- 保持文件写入职责独立，避免散落在 engine 主流程中

## 测试策略

本轮遵循 TDD，先补失败测试，再调整生产代码。测试重点不是“prompt 文案长什么样”，而是“编排协议是否把边界带到了最终生成阶段”。

至少应覆盖以下场景：

1. 推理入口会生成并传递 `currentTime`
2. generation prompt 中每条 injected anchor 都包含 `updatedAt`
3. Query 在进入 recall 前会先生成 decomposition 结果
4. recall judgment 能输出 required goal 的 `known / missing / sufficient`
5. 当某一轮没有新增 anchor 时，会以 `no-new-anchors` 提前停止
6. 当某一轮新增 anchor 但没有减少 missing 时，会以 `no-missing-reduced` 提前停止
7. 当 required goals 仍有 missing 时，final prompt 仍会显式注入这些缺口
8. reasoning chain 会被传入 final prompt，但不会被当作确定事实来源
9. decomposition parse 失败时会回退到默认 goals，而不是整次推理报错
10. judgment parse 失败时会按既定回退结束 recall，不会把非法结构继续向下传递
11. 最近一次推理样本会稳定写入 `debug/reasoning-last/`，并以原子替换方式覆盖旧样本
12. 模型若遗漏 required goal，runtime 会补回 `unassessed-required-goal`，不会把该缺口静默吞掉
13. unknown `missingKeys` 会被确定性归一化，而不是直接参与增益判断

推荐测试位置：

- `packages/server/test/reasoning/engine.test.ts`
- `packages/server/test/reasoning/prompts.test.ts`
- `packages/server/test/recall/goal-based-recall.test.ts`

如需覆盖落盘行为，可增加一个小型文件系统测试或 engine 集成测试。

## 风险与权衡

### 风险 1：Prompt 变长

加入 decomposition、goalStatus、missing 和 reasoning chain 后，generation prompt 会变长。这是可接受的第一版成本，因为当前阶段更重视回答边界与召回质量，而不是极限压缩 token。

### 风险 2：Reasoning chain 被模型误当证据

因此必须在 final prompt 中加入硬规则：逻辑链路只能帮助组织回答，不能替代锚点证据。

### 风险 3：调试样本可能包含敏感内容

这也是将其限制为“最近一次、本地固定目录、覆盖式写入”的原因。先满足开发排查需求，不做更大范围的可视化传播。

## 验收标准

- generation prompt 中稳定包含 `currentTime`
- 注入给 generation 的每条 anchor 都包含 `updatedAt`
- Query 会先做 decomposition，再进入 recall
- 即使走 `full-injection`，也仍然会产出 decomposition、goalStatus、missing 与最终边界约束
- recall loop 能输出 required goal 的 `known / missing / sufficient`
- 最终 `sufficient` 由 runtime 根据归一化后的 required-goal 状态计算，而不是直接信任模型布尔值
- 当补召回无增益时会提前停止，而不是机械跑满轮数
- final prompt 显式包含 missing 信息和 reasoning chain
- 缺失信息时，回复会承认不知道，而不是把缺口脑补成结论
- 最近一次推理样本会稳定写入 `debug/reasoning-last/`，并避免并发交叉写入

## 后续演进

本轮先把推理编排层立起来，后续还可以继续推进：

- 将调试样本扩展成可搜索的调试页
- 引入更精细的锚点时效性策略，而不是仅靠 `updatedAt` 暗示
- 将 goalStatus 与 missing 进一步结构化成 claim / evidence / gap 图
- 基于真实运行样本，再决定是否需要 prompt 压缩与更细粒度的停止策略
