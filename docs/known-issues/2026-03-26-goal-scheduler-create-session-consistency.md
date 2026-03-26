# KNOWN ISSUE: `create_session` 一致性缺口

## 背景

在当前目标管理与主动调度 MVP 里，调度器单轮流程固定为：`refresh -> recompute -> path_select -> act`。

当本轮决策是 `create_session` 时，平台需要为某个 `session` 叶子节点创建对应的外部 execution session，并把这个外部 session 绑定回本地 `goal_nodes`。

当前实现位于 `packages/server/src/goals/scheduler.ts`，其关键顺序是：

1. 先调用 execution layer 的 `createSession()`
2. 再调用本地 service / repository 创建 `session` 节点并写入 `external_session_id`

## 问题描述

这个顺序存在一个尚未闭环的一致性缺口：外部 session 可能已经创建成功，但本地持久化随后失败。

一旦发生这种情况，系统会进入“外部存在、本地不存在”的不一致状态，也就是孤儿 session：

- execution layer 中已经有真实 session
- 本地 `goal_nodes` 中没有对应节点，或没有成功绑定 `external_session_id`
- 后续刷新流程无法通过本地树重新发现并接管这个 session

## 触发时序

典型故障时序如下：

1. 调度器选中某条路径，决定执行 `create_session`
2. 平台成功调用 execution layer，外部 session 创建成功
3. 在写本地数据库时发生失败，例如：
   - SQLite 写失败
   - 事务回滚
   - 进程崩溃
   - service 校验或约束在最后一步拒绝提交
4. 本轮结束后，外部 execution session 已存在，但本地树没有可靠记录

## 当前影响

这个问题不会影响已有 session 的 `refresh`、`append`、状态重算和公平轮询逻辑；它只影响 `create_session` 这条分支。

但一旦命中，影响比较明确：

- 本地目标树失去对该外部 session 的引用
- 调度器无法安全判断这个 session 是否应继续推进、取消或忽略
- 由于当前协议没有 delete / idempotent create primitive，平台也无法做严格意义上的自动补偿
- 这会破坏“本地树是调度入口、execution layer 是执行载体”之间的映射完整性

## 为什么暂不修复

当前结论是：这个问题真实存在，但在 MVP 阶段先记录为 KNOWN ISSUE，而不是立刻修补。

原因是立即修复会明显引入新的状态复杂度或协议复杂度，例如：

- 在本地增加 reservation / pending / staged 等中间态
- 为 `session` 节点增加额外恢复字段或绑定阶段
- 为 execution layer 增加 delete 能力
- 为 execution layer 增加幂等创建语义
- 为平台增加崩溃恢复扫描与补偿流程

这些方案都可能是合理的，但都超出了当前 MVP 想先验证的最小闭环。

## 未来闭环方向

后续如果要补齐这个问题，当前最自然的方向有两类：

### 方向 A：本地先保留可恢复记录，再创建外部 session

大致思路：

1. 先在本地写入一个可追踪的 reservation / pending 记录
2. 再调用 execution layer `createSession()`
3. 成功后把本地记录升级为正式 `session` 节点，并绑定 `external_session_id`

这个方向的优点是恢复锚点在本地，平台更容易知道自己“创建到哪一步了”；缺点是会把当前简洁的节点状态模型扩展出新的中间阶段。

### 方向 B：给 execution layer 增加补偿或幂等原语

大致思路：

- 增加 `deleteSession` 之类的补偿接口，允许本地落库失败后回滚外部创建
- 或增加幂等 `createSession` 语义，使平台可以安全重试并重新绑定同一个外部 session

这个方向的优点是平台状态模型可以更干净；缺点是需要修改 execution layer 协议，超出当前 MVP 边界。

## 当前结论

截至当前版本，`create_session` 的 crash-safe / recovery-safe 一致性仍未完全闭环。

这是一个已知限制，不是未知风险。后续在补齐平台与 execution layer 的恢复语义时，应优先回到这里继续收口。
