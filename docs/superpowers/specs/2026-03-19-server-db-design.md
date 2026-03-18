# HTTP 服务器 + 数据库层设计

## 概述

为 ReMi 搭建 HTTP 服务器基础设施和 per-user SQLite 数据库层。这是访谈引擎和推理引擎的基础依赖，提供 API 路由、认证中间件绑定、灵魂锚点 CRUD、以及 GDPR 全量删除和密钥迁移能力。

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| HTTP 框架 | Hono | 轻量、TypeScript-first、中间件模型干净 |
| 数据库 | better-sqlite3 | 同步 API 简单直接；sqlite-vec 扩展支持成熟，后续可做向量检索 |
| ORM | Drizzle ORM | 常规 CRUD 类型安全；向量检索时可用 raw SQL 绕过 |
| 包结构 | 全部放 @remi/server | MVP 阶段不过度拆分，DB 逻辑和 HTTP 逻辑共处一个包 |

## Server 包结构

```
packages/server/
  src/
    index.ts                # 应用入口，启动 Hono 服务器
    app.ts                  # Hono app 创建 + 中间件挂载 + 路由注册
    middleware/
      auth.ts               # 已有：签名验证逻辑（framework-agnostic）
      role.ts               # 已有：角色判定逻辑（framework-agnostic）
      hono-auth.ts          # 新增：Hono 中间件适配器
    db/
      schema.ts             # Drizzle schema 定义
      connection.ts         # per-user DB 连接管理
      migrate.ts            # Schema 初始化（建表）
    routes/
      anchors.ts            # 灵魂锚点 CRUD 路由
      soul.ts               # Soul 级操作（删除、迁移）
      health.ts             # 健康检查路由
    types.ts                # 共享类型定义
  drizzle.config.ts         # Drizzle Kit 配置（migration 管理）
```

## 数据库设计

### 存储模型

每个用户（pubKey）对应一个独立的 SQLite 文件：`{DATA_DIR}/{pubKey}.sqlite`。`DATA_DIR` 通过环境变量配置，默认为项目根目录下的 `data/`。

- 数据隔离天然，不需要在查询层面做租户过滤
- GDPR 全量删除 = 删除文件
- 备份/导出 = 复制文件
- 密钥迁移 = 重命名文件

### Schema

#### soul_anchors（灵魂锚点）

灵魂锚点是问答对，锚定灵魂本质的核心问题与答案。

| 列名 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | TEXT | PK | UUID v4 |
| question | TEXT | NOT NULL | 锚点问题 |
| answer | TEXT | - | 锚点答案（NULL = 未探索） |
| source | TEXT | NOT NULL | 来源：`'interview'` / `'manual'` |
| created_at | INTEGER | NOT NULL | 创建时间（Unix timestamp ms） |
| updated_at | INTEGER | NOT NULL | 更新时间（Unix timestamp ms） |

#### memories（记忆）— Schema 预留，本次不实现 API

memories 表在本次建表时一并创建，但不提供 HTTP API。记忆的写入将由访谈引擎在服务端内部完成，不需要客户端直接操作。记忆是不可变的（一旦写入不修改），因此没有 `updated_at` 列。

| 列名 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | TEXT | PK | UUID v4 |
| content | TEXT | NOT NULL | 记忆内容（陈述句） |
| occurred_at | INTEGER | NOT NULL | 记忆发生的时间（Unix timestamp ms） |
| source | TEXT | NOT NULL | 来源：`'interview'` / `'manual'` |
| metadata | TEXT | - | JSON 格式的元数据（预留扩展） |
| created_at | INTEGER | NOT NULL | 创建时间（Unix timestamp ms） |

### 设计要点

- **无 user_id 列**：per-user DB 天然隔离，不需要租户过滤
- **answer 可为空**：对应概念"答案为空意味着还没探索到"
- **source 字段**：区分访谈产出和手动输入
- **metadata 预留**：JSON 字符串，后续可存关联的对话 ID 等
- **时间戳用毫秒级整数**：Unix timestamp，SQLite 原生排序友好
- **向量字段后续加**：等引入 sqlite-vec 时再加 embedding 列

### 连接管理

使用 LRU cache 管理已打开的 DB 连接：

- Key: pubKey (string)
- Value: BetterSqlite3.Database + DrizzleInstance
- 最大缓存数量：configurable（默认 100）
- 淘汰策略：LRU，关闭时调用 `db.close()`

**职责边界：** 连接管理器（`connection.ts`）只负责"给我一个 pubKey，返回一个 DB 连接"。它不感知角色。Soul 是否存在的判断和隐式创建逻辑由路由中间件（Soul 中间件）负责：

1. Soul 中间件检查 `data/{pubKey}.sqlite` 是否存在
2. 不存在且 role = owner → 调用连接管理器创建（create = true）
3. 不存在且 role = visitor → 返回 404，不调用连接管理器
4. 存在 → 调用连接管理器获取连接（create = false）

连接管理器的接口：`getConnection(pubKey, options?: { create?: boolean })`。`create = true` 时创建文件并初始化 schema；`create = false` 时文件不存在则抛异常。

## API 设计

### URL 结构

所有 API 路由以 `/api` 为前缀。`/s/{pubKey}` 保留给前端短链接路由。

### 访问模型说明

所有锚点管理 API 仅限 owner 访问。Visitor（第三方）不通过 HTTP API 直接读取锚点——推理引擎在服务端内部读取锚点并生成回复，visitor 只通过未来的"提问"API 与分身交互。这与 auth spec 中"第三方仅向分身提问"的定义一致（auth spec 中的"本体" = 本 spec 中的 owner，"第三方" = visitor）。

### 路由表

| 方法 | 路径 | 认证 | 角色 | 说明 |
|------|------|------|------|------|
| GET | `/api/health` | 无 | - | 健康检查 |
| DELETE | `/api/:pubKey` | 需要 | owner | 删除整个 Soul (GDPR) |
| POST | `/api/:pubKey/copy` | 需要 | owner | 复制 Soul 到新 pubKey |
| GET | `/api/:pubKey/anchors` | 需要 | owner | 列出所有锚点 |
| POST | `/api/:pubKey/anchors` | 需要 | owner | 创建锚点 |
| DELETE | `/api/:pubKey/anchors` | 需要 | owner | 清空所有锚点 |
| GET | `/api/:pubKey/anchors/:id` | 需要 | owner | 获取单个锚点 |
| PUT | `/api/:pubKey/anchors/:id` | 需要 | owner | 更新锚点 |
| DELETE | `/api/:pubKey/anchors/:id` | 需要 | owner | 删除锚点 |

### 鉴权流程

```
请求到达
  → hono-auth 中间件：提取 X-Public-Key, X-Timestamp, X-Signature headers
  → 调用已有的 verifyRequest()（packages/server/src/middleware/auth.ts）
  → 失败 → 返回 401 { error, message }
  → 成功 → 将 signerPubKey 注入 Hono Context
  → role 中间件：对比 signerPubKey 与 URL :pubKey
  → 注入 role ("owner" | "visitor") 到 Hono Context
  → 路由处理器检查角色
```

### 请求/响应格式

**成功响应：**
```json
{ "data": "<T>" }
```

**错误响应：**
```json
{ "error": "<ERROR_CODE>", "message": "<human readable>" }
```

**错误码：**

| 错误码 | HTTP 状态码 | 说明 |
|--------|-----------|------|
| MISSING_AUTH_HEADER | 401 | 缺少认证 headers |
| TIMESTAMP_EXPIRED | 401 | 时间戳过期（30s 窗口） |
| INVALID_SIGNATURE | 401 | 签名验证失败 |
| FORBIDDEN | 403 | 角色不足（visitor 试图访问 owner 接口） |
| SOUL_NOT_FOUND | 404 | Soul 不存在（visitor 请求未创建的 Soul） |
| ANCHOR_NOT_FOUND | 404 | 锚点不存在 |
| COPY_TARGET_EXISTS | 409 | 复制目标 pubKey 已有 Soul |
| VALIDATION_ERROR | 422 | 请求体校验失败 |
| INTERNAL_ERROR | 500 | 服务器内部错误（DB 损坏、文件操作失败等） |

**幂等性说明：** `DELETE /api/:pubKey` 和 `DELETE /api/:pubKey/anchors/:id` 是幂等的——对已删除的资源重复 DELETE 返回 204（而非 404）。

### 关键端点详细设计

#### POST /api/:pubKey/copy

复制 Soul 到新 pubKey。用于密钥迁移的第一步。

迁移密钥的完整流程是 **copy + delete 两步操作**：先 copy 到新 key，用新 key 验证可用后，再 delete 旧 key。任何一步失败都不会丢数据。

**请求体：**
```json
{ "targetPubKey": "<base58 encoded public key>" }
```

**行为：**
1. 验证请求者是 owner
2. 验证 targetPubKey 格式有效（base58 decode 成功）
3. 检查 targetPubKey 对应的 Soul 是否已存在 → 存在则返回 409 COPY_TARGET_EXISTS
4. 复制文件 `{DATA_DIR}/{pubKey}.sqlite` → `{DATA_DIR}/{targetPubKey}.sqlite`
5. 返回 201 `{ data: { targetPubKey: targetPubKey } }`

复制完成后，新旧两个 Soul 同时存在且数据一致。用户用新 key 签名验证可用后，再调用 `DELETE /api/:pubKey` 删除旧 Soul。

**安全考量：** 只验证旧 owner 的签名权限。新 pubKey 的所有权不在此请求中验证——owner 自行决定复制到哪个 key。

#### DELETE /api/:pubKey

删除整个 Soul（GDPR 被遗忘权）。

**行为：**
1. 验证请求者是 owner
2. 关闭 DB 连接（从 LRU cache 移除）
3. 删除文件 `data/{pubKey}.sqlite`
4. 返回 204 No Content

#### DELETE /api/:pubKey/anchors

清空所有锚点但保留 Soul。

**行为：**
1. 验证请求者是 owner
2. DELETE FROM soul_anchors
3. 返回 204 No Content

#### GET /api/:pubKey/anchors

列出所有锚点，支持分页。

**查询参数：**
- `limit`: 每页条数（默认 50，最大 200）
- `offset`: 偏移量（默认 0）

**排序：** 按 `created_at DESC`（最新创建的在前）。排序固定，不支持自定义。

**响应：**
```json
{
  "data": {
    "items": ["..."],
    "total": 123,
    "limit": 50,
    "offset": 0
  }
}
```

#### POST /api/:pubKey/anchors

创建锚点。

**请求体：**
```json
{
  "question": "你对 AI 的看法是什么？",
  "answer": "我认为...",
  "source": "manual"
}
```

`answer` 可选，`source` 取值 `'interview'` 或 `'manual'`。

**响应：** 201 + `{ data: <anchor> }`

#### PUT /api/:pubKey/anchors/:id

更新锚点（主要场景：填充 answer）。

**请求体：** 部分更新，只传需要修改的字段
```json
{
  "answer": "经过深思熟虑，我认为..."
}
```

可更新字段：`question`, `answer`, `source`。

**响应：** 200 + `{ data: <anchor> }`

## Soul 隐式创建

当 owner 首次请求任何需要认证的端点时：
1. 检查 `data/{pubKey}.sqlite` 是否存在
2. 不存在 → 自动创建 DB 文件，初始化 schema（建表）
3. 继续处理请求

Visitor 请求不存在的 Soul → 返回 404 SOUL_NOT_FOUND。

这意味着"注册"是完全隐式的：用户第一次发起签名请求，Soul 就自动创建了。

## 依赖项

### 新增生产依赖

- `hono`: HTTP 框架
- `@hono/node-server`: Hono 的 Node.js 适配器
- `better-sqlite3`: SQLite 驱动
- `drizzle-orm`: ORM
- `lru-cache`: LRU 缓存（DB 连接池）
- `zod`: 请求体校验（配合 `@hono/zod-validator`）
- `@hono/zod-validator`: Hono 的 Zod 校验中间件

### 新增开发依赖

- `@types/better-sqlite3`: 类型定义
- `drizzle-kit`: Drizzle migration 工具

### UUID 生成

使用 Node.js 内置的 `crypto.randomUUID()`，不引入额外依赖。

## 测试策略

- **DB 层单元测试**：使用临时文件测试 schema 初始化、CRUD 操作
- **中间件单元测试**：测试 Hono auth 中间件的 header 提取和错误处理
- **路由集成测试**：使用 Hono 的 `app.request()` 测试 API 端点（不启动真实 HTTP 服务器）
- **Soul 生命周期测试**：测试隐式创建、GDPR 删除、copy + delete 密钥迁移
- 临时测试目录用 `os.tmpdir()` + 随机后缀，测试后清理

## 已知限制（MVP 接受）

- 无速率限制：依赖运营监控
- 无请求体大小限制：Hono 默认限制足够
- 无缓存策略：每次请求都查 DB
- LRU cache 没有过期时间：只按容量淘汰
- copy 不验证 targetPubKey 所有权
- copy 后新旧 Soul 数据独立，后续修改不会同步
