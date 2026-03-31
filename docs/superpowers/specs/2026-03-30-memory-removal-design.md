# Memory Removal Design

## 背景

`README.md` 已明确说明 ReMi 在 MVP 中不再把 memory 作为分身内部的一等认知对象管理。当前服务端数据库初始化、Drizzle schema、向量索引类型与测试中仍保留 `memories` / `memories_vec`，实现与产品边界不一致。

现状补充约束：用户已确认现存数据库中的 `memories` 与 `memories_vec` 均为空表，因此可以直接删除，不做数据搬迁、非空探测或兼容保留。

## 目标

- 删除运行时代码中的 `memories` / `memories_vec` 相关定义与逻辑
- 停止新建 `memories` / `memories_vec`
- 提供一次性、显式、可控的迁移入口，用于删除指定旧库中的 `memories` / `memories_vec`
- 更新测试，确保新的数据库契约被覆盖

## 非目标

- 不改历史设计文档、历史计划文档
- 不引入新的 memory 替代概念或兼容包装层
- 不处理非空 memory 数据迁移
- 不在常规服务启动路径中自动删表

## 前置条件

- 用户已确认当前需要处理的旧数据库中，`memories` 与 `memories_vec` 都为空表
- 执行显式迁移前，操作者必须先备份目标 SQLite 文件
- 若未来这个“空表”前提失效，删除风险由操作者承担；实现不做运行时空表探测

## 方案对比

### 方案 A：常规启动时自动删表

在 `initializeDatabase` 中加入一次性 destructive migration，在服务打开旧库时自动删除 `memories` / `memories_vec`。

缺点：

- 会把一次性清理变成长期存在的启动副作用
- 需要额外 gate、版本控制、路径校验与失败语义，复杂度过高
- 误操作风险高，不符合当前问题规模

### 方案 B：运行时代码删除 + 显式迁移命令（推荐）

常规启动路径只负责停止创建与引用 `memories` / `memories_vec`。对于已有旧库，提供单独的 server 迁移脚本/命令，要求操作者显式传入目标 SQLite 文件路径后执行删表。

优点：

- 运行时契约与 README 对齐
- 破坏性操作从服务启动路径中移除，风险边界清晰
- 实现更小、更容易验证

缺点：

- 需要操作者对旧库额外执行一次迁移命令

## 详细设计

### 运行时代码

- 删除 `CREATE TABLE IF NOT EXISTS memories`
- 删除 `rebuildTableWithoutSourceConstraint` 中对 `memories` 的升级分支
- 删除 `CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec`
- 常规 `initializeDatabase` 不再负责删除 legacy memory 表

这样新建数据库不会再包含 `memories` / `memories_vec`，服务启动路径中也不再携带 destructive 删除逻辑。

### 显式迁移入口

- 增加一个一次性迁移入口，例如 `packages/server/src/db/remove-memory-tables.ts`
- 定义唯一可执行入口：`tsx packages/server/src/db/remove-memory-tables.ts --db /absolute/path/to/user.sqlite`
- 该入口接收目标 SQLite 文件绝对路径，只处理单个明确指定的数据库文件
- 命令在打开 SQLite 前必须先校验目标路径：
  - 必须是绝对路径
  - 必须已存在
  - 必须是普通文件
  - 任一条件不满足时直接失败，且不得创建新数据库文件
- 执行流程：
  - 打开目标数据库
  - 加载 `sqlite-vec`
  - 在单个事务中执行 `DROP TABLE IF EXISTS memories_vec` 与 `DROP TABLE IF EXISTS memories`
  - 关闭数据库
- 命令失败时直接返回非零退出码与可操作错误，不做静默跳过
- 命令输出应明确提示：目标路径、删除结果、以及“执行前需备份”的要求

### Drizzle Schema

- 删除 `packages/server/src/db/schema.ts` 中的 `memories` 导出

### Embedding 层

- 将 `VecTable` 从 `"soul_anchors_vec" | "memories_vec"` 收敛为仅 `"soul_anchors_vec"`
- 保持 `upsertEmbedding` / `searchSimilar` / `deleteEmbedding` API 形状不变，仅收窄可传入表名

### 测试

- 更新数据库迁移测试，不再断言 `memories` / `memories_vec` 存在
- 为显式迁移入口新增测试：
  - 缺失路径会失败，且不会创建新数据库文件
  - 旧库含 `memories` / `memories_vec` 时，执行后两表被删除
  - 只存在其中一个表时也能成功
  - 重复执行仍然成功
- 删除 embedding 测试中针对 `memories_vec` 的用例

## 错误处理与风险

- 如果某个旧库意外含有非空 memory 数据，显式迁移会直接删除它；本次按用户确认接受该约束，不额外增加保护逻辑
- 迁移风险被收敛到人工执行的单次命令，而不是常规服务启动
- embedding 层收窄后，如仍有遗漏调用点，TypeScript 编译与测试会直接暴露问题

## 回滚

- 本次迁移中的 `DROP TABLE` 不可逆，不提供历史 memory 数据恢复能力
- 如果需要恢复到执行前状态，只能使用迁移前备份的 SQLite 文件
- 代码层回滚只恢复旧契约，不恢复已删除数据

## Runbook

1. 停止使用目标数据库的服务进程
2. 备份目标 SQLite 文件
3. 运行显式迁移命令，传入目标 SQLite 文件路径
4. 确认命令输出显示 `memories` / `memories_vec` 已删除
5. 启动新版本服务

## 验证

- 运行数据库迁移与 embedding 相关测试
- 运行显式迁移入口测试
- 运行 server 包构建或类型检查，捕获删除 schema 导出与收窄 `VecTable` 后的编译期遗漏调用
- 验证新建数据库不再包含 `memories` / `memories_vec`
- 验证显式迁移命令只影响传入的目标数据库文件
