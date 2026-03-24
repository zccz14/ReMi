# User Public Profile 设计文档

## 目标

为 ReMi 增加一套可公开访问的用户公开资料（User Public Profile）能力，让用户可以在设置页维护自己的昵称、头像、个人简介，并通过现有的分享链接 `/profile/:pubKey` 被任何访客访问。

本期目标是先把“可分享的公开名片”闭环跑通，不引入字段级隐私控制、自定义字段、第三方图床或动图头像支持。

## 背景与现状

- 当前公开页 `packages/web/src/pages/ProfilePage.tsx` 仅展示公钥和“发消息”按钮，不是真正的公开资料页。
- 当前设置页 `packages/web/src/pages/SettingsPage.tsx` 只有密钥导入导出和语言设置，没有公开资料编辑能力。
- 当前项目的服务端存储模型是 `SQLite per-user`：每个 `pubKey` 对应一个独立 sqlite 文件，访谈、推理、消息等能力都基于这个模型读写。

因此，本设计遵循现有架构：公开资料也按用户归属，存储在该用户自己的 sqlite 文件中。访问某个用户的公开资料时，服务端打开对应 `pubKey` 的数据库读取。

## 设计原则

1. **延续现有存储模型**：不引入额外全局用户主表或独立 profile 总库。
2. **公开资料与灵魂锚点分离**：公开资料是展示对象，不应混入 `soul_anchors`。
3. **文本资料与头像资源分离**：轻量 profile 查询不应携带二进制头像数据。
4. **优先产品闭环**：先完成昵称 / 头像 / 简介的公开展示与编辑，不做过早扩展。
5. **头像体验优先**：支持手动方形裁剪，避免公开页头像质量不稳定。

## 范围

### In Scope

- 用户在设置页编辑公开昵称、个人简介
- 用户上传静态头像图片
- 前端进行 1:1 手动裁剪
- 前端将裁剪结果统一导出为 `image/webp`
- 服务端存储最终头像二进制
- 公开访问用户资料页 `/profile/:pubKey`
- 新增公开 profile API 与公开头像 API

### Out of Scope

- 字段级可见性开关
- 自定义 profile 字段
- 第三方图床 / 外部对象存储
- GIF / 动图头像支持
- 原图保留、裁剪视口重放
- 服务端图片裁剪、压缩、缩略图生成
- 头像审核、美颜、滤镜、旋转等高级编辑

## 数据模型

### 1. `public_profile`

每个用户数据库最多一条，表达“当前公开资料文本信息”。

建议字段：

- `id`: `TEXT PRIMARY KEY`，固定值，例如 `singleton`
- `display_name`: `TEXT NULL`
- `bio`: `TEXT NULL`
- `updated_at`: `INTEGER NOT NULL`

迁移要求：

- 两张新表都必须接入 `packages/server/src/db/migrate.ts` / `initializeDatabase()` 的幂等初始化流程
- 由于当前 `ConnectionManager.getConnection()` 每次打开用户库时都会执行 `initializeDatabase()`，因此这两张表的创建必须采用幂等 SQL（如 `CREATE TABLE IF NOT EXISTS`）
- 这保证历史已有的 per-user sqlite 文件在首次被 profile 相关读写访问时也能自动完成 schema bootstrap，而不需要单独离线迁移

说明：

- `display_name` 允许为空；公开页在为空时回退为截断公钥。
- `bio` 允许为空；公开页为空时不展示简介区块。
- 使用固定主键单行模型，而不是 EAV。因为该对象结构稳定、字段极少、语义固定，单行宽表更符合其本质。

### 2. `public_profile_avatar`

每个用户数据库最多一条，表达“当前公开头像资源”。

建议字段：

- `id`: `TEXT PRIMARY KEY`，固定值，例如 `singleton`
- `blob`: `BLOB NOT NULL`
- `updated_at`: `INTEGER NOT NULL`

说明：

- 不存 `mime_type`。本期前端统一导出 `image/webp`，后端固定以 `image/webp` 响应。
- 将头像独立拆表，而不是放入 `public_profile`，目的是让常规 profile 查询保持轻量，避免文本资料读取时碰触二进制数据。

## API 设计

### 公开读取

#### 路由接入方式

当前服务端的鉴权与上下文注入只覆盖 `/api/:pubKey...` 路径；新的公开路由不应复用这套 owner / visitor 鉴权链路。

因此本期需要新增独立的公开 profile routes，例如 `publicProfileRoutes`，并在 `packages/server/src/app.ts` 中直接挂载到 `/api/public/...`。

这里必须额外处理当前 Hono 路由匹配的覆盖问题：按现有写法，`app.use("/api/:pubKey/*", authMiddleware())` 会把 `/api/public/:pubKey/profile` 中的 `public` 误当成 `:pubKey`，从而导致公开接口被鉴权中间件拦截。

因此本期必须明确采用以下约束之一，并在实现中写死，不留模糊空间：

1. **推荐方案**：先注册 `/api/public/*` 的公开 routes，再注册 `/api/:pubKey*` 的鉴权中间件与 owner / visitor 业务 routes。
2. **备选方案**：收窄现有鉴权中间件的匹配模式，使其不覆盖 `/api/public/*`。

推荐采用方案 1，因为它改动更小，也更直观。

这些路由的行为约束应明确为：

- 不经过 `authMiddleware()`
- 不依赖 `determineRole()`
- 在路由内部自行校验 `pubKey` 格式（沿用现有 base58 公钥校验逻辑）
- 通过 `ConnectionManager.soulExists(pubKey)` 判断目标用户库是否存在
- 若不存在则返回 `404`
- 若存在则通过 `connMgr.getConnection(pubKey)` 打开对应用户库并读取 profile 数据

这样可以避免把公开访问错误地塞进现有的 owner / visitor 语义中。

#### `GET /api/public/:pubKey/profile`

用途：公开读取某个用户的文本公开资料。

响应示例：

```json
{
  "data": {
    "displayName": "张三",
    "bio": "在做 AI 个人分身。",
    "hasAvatar": true,
    "avatarVersion": 1711267200000,
    "updatedAt": 1711267200000
  }
}
```

行为约束：

- 无需鉴权
- 若目标用户库不存在，返回 `404`
- 若用户存在但未设置公开资料，返回空结构而非报错：

```json
{
  "data": {
    "displayName": "",
    "bio": "",
    "hasAvatar": false,
    "avatarVersion": null,
    "updatedAt": null
  }
}
```

#### `GET /api/public/:pubKey/profile/avatar`

用途：公开读取某个用户头像。

行为约束：

- 无需鉴权
- 若目标用户库不存在，返回 `404`
- 若用户存在但未设置头像，返回 `404`
- 成功时返回图片二进制，响应头固定为：

```http
Content-Type: image/webp
```

缓存约束：

- `GET /api/public/:pubKey/profile` 返回 `avatarVersion`
- 前端在头像 URL 上追加 `?v=<avatarVersion>` 作为 cache buster
- 当头像上传或删除成功后，前端必须重新读取 profile 数据，拿到新的 `avatarVersion`，再刷新预览
- 若 `hasAvatar = false`，前端不请求头像接口

### Owner 写入

#### Owner 读取与设置页初始化

除了公开读取接口，本期还需要增加 owner 自己读取 profile 的接口，用于设置页初始化和编辑态加载。

#### `GET /api/:pubKey/profile`

用途：owner 在设置页读取自己当前的公开资料。

行为约束：

- 仅 owner 可调用
- 走现有 `/api/:pubKey...` 鉴权与上下文注入链路
- 因为现有 `injectContext` 会在 owner 首次访问时隐式创建 soul DB，所以该接口天然具备 bootstrap 能力
- 若资料未设置，返回空结构：

```json
{
  "data": {
    "displayName": "",
    "bio": "",
    "hasAvatar": false,
    "avatarVersion": null,
    "updatedAt": null
  }
}
```

说明：

- `SettingsPage` 不应依赖公开接口作为初始化数据源。
- 设置页应总是使用 owner 读取接口，以确保“新用户首次进入设置页”也能得到可编辑的空态，而不会因为用户库尚未创建而得到 `404`。

#### `PUT /api/:pubKey/profile`

用途：owner 更新公开资料文本信息。

请求示例：

```json
{
  "displayName": "张三",
  "bio": "在做 AI 个人分身。"
}
```

行为约束：

- 仅 owner 可调用
- 非 owner 返回 `403`
- upsert 到 `public_profile`

校验建议：

- `displayName`: trim 后长度 `0-40`
- `bio`: 长度 `0-280`

#### `PUT /api/:pubKey/profile/avatar`

用途：owner 上传最终头像成品。

行为约束：

- 仅 owner 可调用
- 非 owner 返回 `403`
- 请求体为前端导出的最终头像二进制
- 服务端只接受 `image/webp`
- 服务端校验上传大小上限，例如 `2MB`

说明：

- 这里不接收原图，不负责服务端裁剪或压缩。
- 头像处理完全在前端完成，后端只做最终结果存储。
- 由于当前 `packages/web/src/lib/api-client.ts` 仅支持 JSON 请求，本期需要扩展 client 层，增加一条带签名的二进制上传能力（例如 `putBinary()`），用于发送 `image/webp` 请求体，同时保持与现有签名机制一致。
- 该二进制上传的签名契约应与现有 JSON 请求保持一致：仍使用 `method + pathname + timestamp + raw body bytes` 构造 string-to-sign，其中 body bytes 为最终上传的 `webp` 二进制内容，而不是 JSON 包装。
- 请求头应至少包含：`X-Public-Key`、`X-Timestamp`、`X-Signature`、`Content-Type: image/webp`
- 服务端鉴权层不应为 avatar 上传单独设计另一套签名协议，而应复用现有 body-bytes 校验模型

#### `DELETE /api/:pubKey/profile/avatar`

用途：owner 删除当前头像。

行为约束：

- 仅 owner 可调用
- 非 owner 返回 `403`
- 删除 `public_profile_avatar` 的单行记录

## 前端设计

### 1. Settings Page

在 `packages/web/src/pages/SettingsPage.tsx` 中新增一个 Public Profile 区块，放在现有设置项中。

包含内容：

- 昵称输入框
- 个人简介多行输入框
- 当前头像预览
- 上传头像按钮
- 删除头像按钮（已有头像时展示）
- 保存按钮

交互流程：

1. 页面加载时请求 `GET /api/:pubKey/profile` 读取当前 owner 的 profile 文本信息
2. 若存在头像，则展示头像接口地址作为 `<img src>`
3. 用户选择图片后进入裁剪流程
4. 用户在前端完成 1:1 方形裁剪
5. 前端通过 `canvas` 将裁剪结果导出为 `webp`
6. 若导出结果超过限制，则前端继续降低质量 / 分辨率压缩
7. 头像上传成功后，界面立即刷新预览
8. 刷新预览的具体方式是：重新请求 owner profile，读取新的 `avatarVersion`，并更新头像 URL 上的 `?v=` 查询参数
9. 文本资料保存走独立保存动作，不与头像上传强绑定

### 2. Avatar Crop UX

本期只支持静态图：

- 输入允许：`image/png`、`image/jpeg`、`image/webp`
- 明确拒绝：`image/gif`

裁剪流程：

- 用户选图后打开裁剪对话框 / 页面内浮层
- 固定 `1:1` 裁剪框
- 允许拖拽与缩放
- 点击确认后，用 `canvas` 输出最终方形头像

导出建议：

- 统一导出 `image/webp`
- 可设置一个固定输出尺寸，例如 `512x512`
- 通过质量参数和尺寸上限控制最终体积

### 3. Public Profile Page

`packages/web/src/pages/ProfilePage.tsx` 从“公钥页”升级为真正的公开名片页。

展示内容：

- 用户头像（若无则回退 `ChatAvatar`）
- 昵称（若空则回退为截断公钥）
- 个人简介（若空则不展示）
- 公钥辅助信息（保留，弱化展示）
- “发消息”按钮

加载逻辑：

- 先读取 `GET /api/public/:pubKey/profile`
- 若 `hasAvatar = true`，则头像地址使用 `GET /api/public/:pubKey/profile/avatar?v=<avatarVersion>`

### 4. Share Page

`packages/web/src/pages/SharePage.tsx` 继续使用现有分享链接 `/profile/:pubKey`。

变化仅在于：分享出去的链接不再只是展示公钥，而是展示完整公开名片。

## 后端行为与性能判断

### 为什么继续使用 per-user sqlite

- 与当前项目架构完全一致
- 不引入额外全局索引库或第二套用户主表
- 数据跟随用户库一起备份、迁移、删除

### 性能判断

- 当前 `ConnectionManager` 已经使用 LRU 缓存并限制最大连接数（默认 100）
- public profile 的读取是单表 / 单行 / 轻量查询，远轻于访谈和推理链路
- 因此 Phase 1 不需要为了 profile 额外设计全局缓存或聚合库
- 若未来公开 profile 成为显著热点，再考虑增加只读缓存层或聚合索引

## 与现有 soul copy 行为的兼容

当前 `POST /:pubKey/copy` 会直接复制整个 sqlite 文件。引入 `public_profile` 与 `public_profile_avatar` 后，如果保持现状，会把原 soul 的公开身份资料一并复制到新 soul。

本期应明确修正这个行为：

- soul copy 完成后，目标库中的 `public_profile` 与 `public_profile_avatar` 应被清空
- 新 soul 默认回到“未设置公开资料”的空状态

原因：

- 公开资料属于该 public key 对应身份的公开名片，不应在身份复制时被继承
- 否则会出现“新身份默认继承旧身份头像与昵称”的语义错误

## 校验与错误处理

### 文本资料

- `displayName`：trim 后校验长度 `0-40`
- `bio`：校验长度 `0-280`
- 非法输入返回 `422`

### 头像

- 仅接受前端导出的 `image/webp`
- 最终上传体积限制建议为 `2MB`
- 非法 MIME / 超限返回 `422`

### 权限

- owner 之外的用户调用文本或头像写接口，一律返回 `403`

### 缺省状态

- 目标用户库不存在：公开接口返回 `404`
- 资料未设置：profile 接口返回空结构
- 头像未设置：avatar 接口返回 `404`

## 测试策略

### 服务端测试

新增或扩展路由测试，覆盖：

- 未带签名访问 `GET /api/public/:pubKey/profile` 成功，不被 auth middleware 拦截
- 未带签名访问 `GET /api/public/:pubKey/profile/avatar` 成功，不被 auth middleware 拦截
- owner 成功更新 profile 文本信息
- visitor 更新 profile 被拒绝
- 公开读取 profile 成功
- 目标 soul 不存在时公开读取返回 `404`
- profile 未设置时返回空结构
- owner 成功上传头像
- owner 成功删除头像
- 未设置头像时读取头像返回 `404`
- 非 `image/webp` 上传失败
- 超限头像上传失败

### 前端测试

新增或扩展页面测试，覆盖：

- `SettingsPage` 渲染 Public Profile 表单
- 资料加载后正确回填昵称与简介
- 点击保存时调用 profile 更新接口
- 选择头像文件后进入裁剪流程
- 裁剪确认后触发头像上传
- `ProfilePage` 正确展示昵称、简介与头像
- 昵称为空时回退显示截断公钥
- 无头像时回退为 `ChatAvatar`

## 迭代边界与后续演进

本设计故意不为未来可能性过度设计。当前版本刻意放弃：

- GIF 保真支持
- 原图保留
- 裁剪视口参数重放
- 多格式响应

如果未来确实要支持 GIF 或更复杂的头像能力，再进入 Phase 2：

- 重新引入原图存储
- 保存裁剪视口参数
- 增加格式元数据
- 评估服务端转码与缓存策略

在那之前，Phase 1 应优先交付一个稳定、可用、体验统一的静态头像公开名片系统。
