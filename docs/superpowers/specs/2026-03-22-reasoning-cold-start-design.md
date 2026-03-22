# 推理冷启动召回策略设计

## 概述

当前推理流程会在任何锚点规模下都进入多轮 Agentic Recall / Batch Recall。这个策略在中后期锚点较多时有价值，但在冷启动阶段存在明显的设计错位：当锚点总量很少时，系统并不需要从大量候选中做高精度召回，直接全量注入即可获得接近 100% 的召回覆盖，同时显著减少首响应前的等待时间。

本设计将推理流程改为双路径：少锚点阶段优先覆盖率与响应速度，直接全量注入；锚点规模超过阈值后，才进入现有的 Agentic Recall 流程。

## 背景问题

当前实现位于 `packages/server/src/reasoning/engine.ts`，其主要问题不是运行错误，而是策略选择不符合冷启动场景：

- 无论锚点数量多少，都要执行 embedding 检索和 LLM 充分性判断
- 少锚点阶段，多轮 Recall 的收益很低，因为“漏召回”不是主要问题
- 少锚点阶段，多轮 Recall 带来的额外前摇会直接拉长 SSE 首 token 时间
- 产品上更重要的是让用户尽快感受到“分身已经开始会说像样的话了”，而不是在很小的候选集上做复杂召回

因此，冷启动阶段的目标应从“最小充分上下文搜索”切换为“最大覆盖 + 最低延迟”。

## 目标

- 在锚点总量较少时跳过 Agentic Recall，直接全量注入锚点
- 保持现有中后期推理能力不变，锚点变多后继续使用 `batchRecall`
- 让冷启动路径不依赖 embedding 检索和 recall judgment，从而减少失败面与前摇
- 保持 `recalled_anchors` 审计语义一致：冷启动时记录全量注入的锚点 ID

## 非目标

- 本轮不重新设计 Batch Recall 的多目标协议
- 本轮不引入 prompt 长度估算或 token 预算策略
- 本轮不做运行时配置，不暴露 env 开关
- 本轮不处理“中后期 Recall 如何丢弃无关锚点”的更大问题

## 设计决策

| 决策项          | 选择                        | 理由                                     |
| --------------- | --------------------------- | ---------------------------------------- |
| 冷启动策略      | 全量注入全部锚点            | 少锚点时覆盖率优先于选择性               |
| 分流条件        | 基于 soul 的总锚点数        | 简单、稳定、可解释                       |
| 阈值形态        | 全局常量，不做配置化        | 避免复杂化，同时避免 magic number inline |
| 阈值位置        | 推理模块内集中定义          | 便于复用和后续统一调整                   |
| 审计字段        | 继续写入 `recalled_anchors` | 保持前后端与历史消息格式一致             |
| Recall 缓存来源 | 仅从 Recall 路径消息回填    | 避免冷启动全量注入污染后续 recall cache  |

## 核心策略

新增一个全局常量，例如：

```ts
const REASONING_FULL_INJECTION_THRESHOLD = 20;
```

策略规则如下：

- 当 soul 的总锚点数 `<= REASONING_FULL_INJECTION_THRESHOLD` 时：
  - 不执行 `batchRecall`
  - 直接读取全部锚点
  - 将全部锚点传给 `buildAvatarSystemPrompt`
  - 将全部锚点 ID 记录进本次 assistant 消息的 `recalled_anchors`
- 当 soul 的总锚点数 `> REASONING_FULL_INJECTION_THRESHOLD` 时：
  - 保持当前流程，继续执行 `batchRecall`

这意味着系统在冷启动阶段退化为“全量上下文注入器”，在中后期才升级为“召回驱动的上下文构造器”。

## 数据流变更

### 现状

```text
保存用户消息
  -> 读取最近对话
  -> 读取 cached recalled anchors
  -> 无条件 batchRecall
  -> 用 recall 结果生成回复
  -> 保存 recalled_anchors
```

### 调整后

```text
保存用户消息
  -> 读取最近对话
  -> 读取 soul 总锚点数
  -> if 总锚点数 <= 阈值
       -> 直接读取全部锚点
       -> 全量注入生成回复
       -> 保存全部锚点 IDs 到 recalled_anchors
     else
       -> 读取 cached recalled anchors
       -> batchRecall
        -> 用 recall 结果生成回复
        -> 保存 recall 结果 IDs 到 recalled_anchors
```

关键补充：`recalled_anchors` 仍然是审计字段，但不应被无差别地当作后续 Recall 的 cache 来源。否则冷启动阶段写入的“全量锚点 IDs”会在跨过阈值后把 `batchRecall` 的初始缓存错误放大成“上次全部锚点”。

因此需要一个设计硬约束：

- 只有通过 Recall 路径生成的 assistant 消息，才允许其 `recalled_anchors` 作为后续 `cachedAnchors` 输入
- 冷启动全量注入路径生成的 assistant 消息，其 `recalled_anchors` 只用于审计和前端展示，不参与后续 Recall cache

最小实现可以通过额外记录一类内部策略标记实现，例如 `anchor_selection_strategy = full-injection | batch-recall`。具体落库方式可以在 implementation plan 中定稿，但“审计字段”和“Recall cache 来源”必须解耦。

## 模块改动建议

### `packages/server/src/reasoning/engine.ts`

- 在当前 `handleMessage` 流程中增加“冷启动分支判断”
- 在进入 Recall 前先读取总锚点数
- 调用顺序固定为：先 `countAnchors()`，再决定是否读取 cache
- 冷启动分支明确不调用 `getCachedAnchorIds()`，也不调用 `batchRecall`
- 将“选取本轮注入锚点”的逻辑集中成一个小的策略分发块，而不是散落在生成逻辑中
- 对外保持现有 SSE 行为：仍然发 token / done / error
- 冷启动分支不发送 recall narrative，因为不会执行 recall judgment

### `packages/server/src/routes/reasoning.ts`

- 为 `ReasoningEngineDeps` 增加“读取全部锚点”或“按上限读取锚点”的数据接口
- 为 `ReasoningEngineDeps` 增加“读取锚点总数”的接口
- 路由层不再在请求入口统一要求 `embeddingClient` 存在
- 依赖校验改为按分支延迟校验：冷启动只要求 `chatClient`；Recall 路径要求 `chatClient + embeddingClient`
- 路由层负责把这些数据库能力注入给 `ReasoningEngine`

推荐新增依赖接口形态：

```ts
interface ReasoningEngineDeps {
  chatClient: ChatClient;
  embeddingClient?: EmbeddingClient;
  countAnchors(): Promise<number>;
  listAnchors(limit?: number): Promise<SoulAnchor[]>;
  getMessages(visitorKey: string, limit: number): Promise<...>;
  saveMessage(...): Promise<number>;
  searchAnchors(embedding: number[]): Promise<SoulAnchor[]>;
  getCachedAnchorIds(visitorKey: string): Promise<string[]>;
  getAnchorsByIds(ids: string[]): Promise<SoulAnchor[]>;
}
```

其中：

- `countAnchors()` 用于分支判断
- `listAnchors()` 用于冷启动全量注入，默认按稳定顺序返回，推荐 `updatedAt DESC, createdAt DESC`
- `embeddingClient` 在类型上允许缺失，但只有 Recall 路径可以使用它；若 Recall 路径缺失则抛出明确错误

### 常量位置

- 将阈值定义为推理模块内的全局常量
- 不应写成 inline 判断，例如 `anchorCount <= 20`
- 可放在 `reasoning/engine.ts` 顶部，或抽到 `reasoning/constants.ts` 作为同域常量模块

本轮更推荐抽到 `reasoning/constants.ts`，因为它让“冷启动全量注入阈值”成为一个命名策略，而不是隐藏在主流程文件中的实现细节。

## 错误处理

冷启动路径的一个额外收益是失败面减少：

- 少锚点时，不依赖 embedding client
- 少锚点时，不依赖 recall judgment 的 chat 调用
- 因此少锚点阶段即便 embedding / recall 相关依赖异常，仍然可以完成回答生成

这要求路由层与 engine 的依赖契约同步变化：不能继续在请求入口统一因为 `embeddingClient` 缺失而返回 500。

需要注意的是：

- 冷启动路径仍然依赖最终生成回复的 `chatStream`
- 若最终生成失败，仍按现有 `LLM_ERROR` 语义处理
- 冷启动路径与 Recall 路径的错误边界要一致，避免前端需要识别两套 done/error 协议

## 审计与前端兼容

`recalled_anchors` 字段语义保持不变：表示“本次 assistant 回复使用了哪些锚点”。

因此：

- 冷启动路径中，`recalled_anchors` 存的是“全部注入锚点 IDs”
- Recall 路径中，`recalled_anchors` 仍存“Recall 选出的锚点 IDs”
- 前端不需要知道该消息走的是哪条策略路径

这样可以确保：

- `/reasoning/messages` 的返回格式不变
- SSE `done` 事件结构不变
- 调试视角仍然能看到每条回复使用了哪些锚点

但需要再次强调：

- `recalled_anchors` 是审计字段，不再等价于“永远可被下一轮 Recall 直接当缓存复用”
- 若继续复用历史 assistant 的 `recalled_anchors` 作为 cache 来源，必须先过滤掉来自冷启动全量注入路径的消息

## 测试策略

需要新增以下测试，覆盖策略切换而不是只覆盖“流程能跑通”：

1. 冷启动阈值内时不调用 `batchRecall`
2. 冷启动阈值内时会把全部锚点传入回复生成 prompt
3. 冷启动阈值内时 `recalled_anchors` 保存全部锚点 IDs
4. 锚点数超过阈值时仍走现有 Recall 分支
5. 冷启动路径不依赖 embedding / recall judgment 仍能生成回复
6. 阈值边界 `== REASONING_FULL_INJECTION_THRESHOLD` 时仍走冷启动全量注入
7. 路由层在冷启动场景下不会因为缺少 `embeddingClient` 而提前返回 500
8. `GET /reasoning/messages` 与 SSE `done` 结构保持不变
9. 冷启动写入的 `recalled_anchors` 不会污染后续 Recall cache

这些测试应优先放在：

- `packages/server/test/reasoning/engine.test.ts`
- 如有必要，再补一条路由或集成测试验证审计字段形态不变

## 风险与权衡

### 风险 1：冷启动时注入少量无关锚点

这是可接受权衡。因为锚点总量小，少量噪声对最终回答的破坏通常小于“漏掉关键锚点”与“首响应变慢”。

### 风险 2：阈值过大，导致全量注入持续太久

这轮先接受固定阈值的经验性选择。后续若验证发现 prompt 膨胀，可再调整常量，不需要先把系统配置化。

这里需要一个显式假设：当前项目中的锚点长度分布相对可控，`20` 作为第一版经验阈值可以接受。实现时应补充日志，至少记录：

- 本次走了哪条策略路径
- 注入锚点数
- system prompt 字符长度或锚点摘要长度

这样后续可以基于真实数据调阈值，而不是继续拍脑袋。

### 风险 3：策略切换点附近行为不连续

这也是可接受的第一版成本。当前任务的优先级是修正明显不合理的冷启动策略，而不是一次性做最平滑的全阶段召回体系。

## 验收标准

- 少锚点 soul 在推理时不进入 `batchRecall`
- 少锚点 soul 能直接用全部锚点生成回复
- 少锚点 soul 不调用 embed / recall judgment
- 超过阈值后仍保持现有 Recall 行为
- 现有消息 API、SSE done/error 协议、`recalled_anchors` 字段结构不变
- 冷启动消息写入的全量 `recalled_anchors` 不会被错误地当成后续 Recall cache 全量回填

## 后续演进

本设计只解决“冷启动阶段不应无脑做多轮 Recall”的问题。后续还可以继续推进：

- 中后期 Recall 的无关锚点剔除
- 基于相关性排序保留向量搜索顺序
- 更严格的 goal-level state 跟踪
- 从固定锚点数阈值升级为更精细的 prompt 预算策略
