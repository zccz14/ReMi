# 统一 Recall Runtime 与访谈冷启动策略设计

## 概述

当前仓库中存在两套相似但分离的 Recall 实现：

- `packages/server/src/interview/recall.ts`：访谈流程使用的单目标 Agentic Recall
- `packages/server/src/reasoning/batch-recall.ts`：推理流程使用的多目标 Batch Recall

同时，访谈流程与推理流程都存在相同的冷启动问题：当锚点总量很少时，继续执行多轮 Recall 的收益有限，但会明显增加前摇，拖慢用户体感。

本设计要同时解决两个问题：

1. 将 interview / reasoning 的 Recall 收敛成一个统一的 goal-based recall runtime
2. 将“少锚点时全量注入”的冷启动策略扩展到访谈流程
3. 仅优化 Recall 前摇，不改变 interview message 链路整体对 embedding 的依赖边界

## 核心定义

Recall 的真正职责是：**根据当前上下文，智能地从锚点库中推荐出足够的锚点，供后续推理或访谈使用。一次调用完成后，其返回值即可视为当前时刻尽力而为的召回结果。**

这意味着 Recall 本身：

- 只负责本次调用的锚点选择
- 不负责消息持久化
- 不负责审计字段语义
- 不负责跨轮业务 cache 管理
- 不应关心其结果之后如何被业务层保存或展示

Recall Runtime 的输出不能直接等同于业务持久化语义；业务层若需要保存审计或 cache 元数据，必须自行映射。

因此，Recall Runtime 的输入输出应聚焦于“这一次该返回哪些锚点”，而不是承载业务层状态管理。

## 背景问题

### 问题 1：Recall 实现重复但概念不统一

`packages/server/src/interview/recall.ts` 与 `packages/server/src/reasoning/batch-recall.ts` 的主循环高度相似：

- 根据 query 做 embedding 检索
- 累积命中锚点
- 调用 LLM 判断充分性
- 根据 `next_query` 进入下一轮
- 直到 sufficient 或超出轮次

但两者在命名和协议上分叉，导致：

- 维护成本重复
- 冷启动策略需要各改一遍
- 后续 Recall 优化无法稳定在一个抽象层沉淀

### 问题 2：访谈流程也存在冷启动错位

`packages/server/src/interview/engine.ts` 当前会无条件执行 `runRecall()`。这在锚点数很少时不合理：

- 访谈主持人本就会拿到最近消息作为上下文
- 锚点很少时，全量注入即可获得接近 100% 的召回覆盖
- 多轮 Recall 会增加 phase 前摇，拖慢前几轮访谈节奏

因此访谈与推理一样，都应支持冷启动直通策略。

## 目标

- 新建统一的 goal-based recall runtime，替代现有 interview / reasoning 两套 Recall 实现
- interview 改为传入单个 goal，作为多 goal Recall 的退化特例
- reasoning 继续传入多个 goals，保留现有能力
- recall runtime 支持冷启动全量注入策略
- interview 在少锚点时也跳过多轮 Recall，直接全量注入锚点
- reasoning 保持已有 `anchor_selection_strategy` 与 cache 过滤语义不变
- interview 不新增 `recalled_anchors` 持久化语义；Recall 结果仅用于当次生成
- 只优化 interview 的 Recall 前摇，不改变 interview message 整体仍依赖 embedding 的事实

## 非目标

- 本轮不重新设计 reasoning 的 cache 持久化模型
- 本轮不引入可配置阈值或 token 预算策略
- 本轮不处理中后期 Recall 的相关性剪枝问题
- 本轮不改变 interview / reasoning 的外部 API 与 SSE 协议
- 本轮不把“Recall 冷启动可不走 embedding”扩展成“整个 interview message 链路可无 embedding 运行”

## 设计决策

| 决策项               | 选择                             | 理由                                            |
| -------------------- | -------------------------------- | ----------------------------------------------- |
| Recall 抽象          | 统一为 goal-based recall runtime | 单 goal 是多 goal 的自然退化                    |
| Interview 协议       | 改为 goals 数组，仅传 1 个 goal  | 统一概念层与执行骨架                            |
| 冷启动策略           | 下沉到统一 recall runtime        | 两条业务链共享同一产品策略                      |
| 阈值策略             | 先复用统一常量                   | 保持策略简单，先统一产品行为                    |
| Interview 审计       | 不记录 `recalled_anchors`        | interview recall 仅服务当次提问，不做后续 cache |
| Reasoning cache 构造 | 继续留在 reasoning 业务层        | cache 来源过滤是业务语义，不属于 recall runtime |
| Runtime 策略名       | 仅作内部执行元数据               | 不直接落库，避免与 reasoning 现有 DB 语义冲突   |

## 统一 Runtime 抽象

建议新增模块，例如：

- `packages/server/src/recall/goal-based-recall.ts`

建议接口形态：

```ts
interface GoalBasedRecallOptions {
  chatClient: ChatClient;
  embeddingClient?: EmbeddingClient;
  goals: string[];
  context: string;
  initialAnchors?: SoulAnchor[];
  countAnchors(): Promise<number>;
  listAnchors(limit?: number): Promise<SoulAnchor[]>;
  searchAnchors(embedding: number[]): Promise<SoulAnchor[]>;
  buildJudgmentPrompt(args: {
    goals: string[];
    anchors: SoulAnchor[];
    context: string;
  }): ChatMessage[];
  parseJudgment(content: string): {
    sufficient: boolean;
    nextQuery?: string;
    narrative?: string;
  };
  onNarrative?: (text: string) => void;
  maxRounds?: number;
}

interface GoalBasedRecallResult {
  anchors: SoulAnchor[];
  narratives: string[];
  rounds: number;
  sufficient: boolean;
  strategy: "full-injection" | "recall-loop";
}
```

## Runtime 行为

### 冷启动分支

当 `countAnchors() <= RECALL_FULL_INJECTION_THRESHOLD` 时：

- 不调用 embedding client
- 不调用 judgment LLM
- 不进入多轮 recall loop
- 直接 `listAnchors()` 返回全部锚点
- 全量锚点按稳定顺序返回，而不是数据库自然顺序
- 返回：
  - `anchors = 全量锚点`
  - `narratives = []`
  - `rounds = 0`
  - `sufficient = true`
  - `strategy = "full-injection"`

这代表：对于少锚点场景，“全量覆盖”本身就是当前时刻的尽力而为结果。

### Recall 分支

当 `countAnchors() > RECALL_FULL_INJECTION_THRESHOLD` 时：

- 从 `initialAnchors` 初始化工作集
- 用 `context` 作为初始 query
- 多轮执行 embedding 检索 + judgment
- 按 `nextQuery` 推进下一轮
- sufficient 或达到轮次上限后返回
- `strategy = "recall-loop"`

## Interview 如何接入

### 当前状态

`packages/server/src/interview/engine.ts` 中的 `runRecall()` 当前无条件调用 `agenticRecall()`。

### 调整后

访谈流程改为调用统一 recall runtime，并传入单 goal：

```ts
goals = ["充分理解本体在当前话题的认知，问出好问题"];
```

同时：

- 最近消息继续按当前方式注入给主持人 prompt
- 少锚点时直接全量注入锚点，不做 Recall loop
- Recall 结果只用于本次 `buildInterviewerSystemPrompt`
- interview assistant message 不新增 `recalled_anchors` 字段语义
- 这次优化只作用于 Recall 前摇；`/interview/message` 后续保存新锚点时仍可继续依赖 embedding

这意味着 interview 只消费 Recall 结果，不持久化 Recall 选择本身。

## Reasoning 如何接入

### 当前状态

`packages/server/src/reasoning/engine.ts` 已经有冷启动策略与 `anchor_selection_strategy` 语义。

### 调整后

reasoning 改为调用统一 recall runtime，并传入多个 goals。需要保留：

- `initialAnchors` 由 reasoning 业务层构造
- `initialAnchors` 的来源仍然只允许来自 `batch-recall` / legacy `NULL` 历史消息
- `full-injection` 历史消息仍不能作为下一轮 cache 来源
- assistant message 继续保存 `recalled_anchors` 与 `anchor_selection_strategy`
- runtime 返回的 `strategy` 由 reasoning 业务层映射后再落库：
  - `full-injection -> full-injection`
  - `recall-loop -> batch-recall`

因此，统一 runtime 只接收 `initialAnchors`，不负责决定这些锚点如何从历史消息中筛出来。

## Judgment 协议统一

当前 interview 使用单目标 judgment prompt，reasoning 使用多目标 judgment prompt。本轮统一后：

- interview 也改用 goals 数组协议
- reasoning 保持 goals 数组协议
- judgment prompt 统一面向 goals 列表工作
- interview 场景下 goals 数组长度恒为 1
- interview 的单 goal 文案固定，不允许在实现时自由漂移

统一后的 judgment 最少需要稳定解析：

- `sufficient`
- `next_query`
- `narrative`

更细粒度的 `goal_status` 可继续保留在 reasoning prompt 中，但统一 runtime 的最小必需协议应保持一致。

## 模块调整建议

### 新增

- `packages/server/src/recall/goal-based-recall.ts`
- 视需要新增 `packages/server/src/recall/prompts.ts` 或 `packages/server/src/recall/types.ts`

### 修改

- `packages/server/src/interview/engine.ts`
  - 接入统一 runtime
  - 删除对旧 `agenticRecall` 的依赖
  - 只优化 Recall 前摇，不改变消息后半段保存锚点时的 embedding 依赖边界
- `packages/server/src/interview/prompts.ts`
  - 将 recall judgment prompt 改成 goals 数组协议
- `packages/server/src/reasoning/engine.ts`
  - 接入统一 runtime
  - 保留 reasoning 侧的 cache 构造与审计落库语义
- `packages/server/src/reasoning/prompts.ts`
  - 如有必要，收敛成统一 judgment prompt builder

### 删除

- `packages/server/src/interview/recall.ts`
- `packages/server/src/reasoning/batch-recall.ts`

## 阈值策略

本轮建议将推理与访谈都复用同一个 recall 域常量，例如：

```ts
export const RECALL_FULL_INJECTION_THRESHOLD = 20;
```

原因：

- 当前更重要的是统一“冷启动直通”这一产品策略
- 不需要在第一版就拆成 interview / reasoning 两套阈值
- 后续如果验证发现二者敏感度不同，再拆分常量即可

需要补充一个实现约束：full injection 读取全部锚点时必须按稳定顺序返回，推荐 `updatedAt DESC, createdAt DESC`。

## 错误处理

统一 runtime 需要满足：

- 冷启动路径不依赖 embedding client
- Recall 路径若缺少 embedding client，应抛明确错误
- interview / reasoning 两边都继续沿用现有 `LLM_ERROR` 边界

需要特别注意：

- reasoning 冷启动路径同样不应失败
- 只有在确实进入 recall loop 时，embedding client 才是硬依赖
- 但这并不等价于整个 interview message 链路可无 embedding 运行：访谈消息在提取出新锚点后，后续向量写入仍可以继续依赖 embedding

## 测试策略

### 公共 runtime

1. 单 goal 时能正常返回 Recall 结果
2. 多 goal 时能正常返回 Recall 结果
3. 阈值内走 full injection，不调用 embedding / judgment
4. 超阈值时进入 recall loop
5. `initialAnchors` 能作为 recall 初始工作集参与补足
6. 缺 embedding client 且进入 recall loop 时抛明确错误
7. full injection 的锚点返回顺序稳定

### Interview 回归

1. 少锚点时不进入 recall loop
2. 少锚点时主持人 prompt 使用全部锚点
3. 最近消息仍正常注入主持人 prompt
4. interview phase / token / done 协议不变
5. interview 不新增 `recalled_anchors` 持久化语义
6. 单 goal goals 数组协议下，Recall 终止性与当前实现保持稳定，不因协议包装增加额外轮次

### Reasoning 回归

1. 继续支持多 goals recall
2. `full-injection` 历史消息不会污染下一轮 `initialAnchors`
3. legacy `NULL` 历史消息仍可作为 `initialAnchors` 来源
4. SSE done 与 `/reasoning/messages` 结构不变
5. runtime `recall-loop` 会被 reasoning 业务层映射回 `batch-recall` 再落库

## 风险与权衡

### 风险 1：Interview judgment prompt 统一后行为轻微变化

这是可以接受的。因为 interview 仅传 1 个 goal，产品目标未变化，变化主要来自 prompt 结构统一。

### 风险 2：统一 runtime 过度承载业务语义

需要通过边界控制避免这一点：

- runtime 只负责本次 recall 结果
- cache 来源过滤继续留在 reasoning 业务层
- interview 不把 recall 结果持久化为跨轮业务状态
- runtime 的 `strategy` 只作内部执行元数据，不直接等于落库字段值

### 风险 3：删除旧实现后，测试覆盖不足会掩盖回归

因此必须按顺序迁移：

1. 先新增统一 runtime 单测
2. 再改 engine 回归测试的 mock 入口
3. 最后删除旧 recall 文件与旧 recall 专属测试

## 验收标准

- interview / reasoning 共用同一套 goal-based recall runtime
- interview 改为 goals 数组协议，单 goal 作为退化特例运行
- interview 与 reasoning 在少锚点时都走 full injection
- interview 的 Recall 冷启动路径跳过 recall loop，但不改变 interview message 整体 embedding 依赖边界
- reasoning 现有 cache 过滤与审计字段语义保持不变
- interview 不新增 `recalled_anchors` 持久化语义
- 旧的 `agenticRecall` / `batchRecall` 文件被移除

## 后续演进

在本设计落地后，后续还能继续推进：

- 在统一 runtime 内加入相关性剪枝/重排
- 从固定阈值升级为 prompt 预算策略
- 进一步统一 reasoning / interview 的 judgment prompt builder
- 为 recall 结果增加更明确的诊断与观测指标
