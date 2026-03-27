# 单体生产部署命令设计

## 背景

当前仓库的默认启动方式是根目录 `npm run dev`，它会通过 `dev.sh` 同时启动：

- 后端 `npx tsx watch packages/server/src/index.ts`
- 前端 `vite` 开发服务器
- 后端在 `WEB_MODE=proxy` 下把非 API 请求代理到 Vite

这适合开发，但不适合单体生产部署。用户希望保留现有开发体验，同时新增一个显式的生产启动命令：

- `npm run dev` 继续用于开发，保留文件监听和热更新
- `npm run deploy` 用于生产启动，不使用 `tsx watch`
- `npm run deploy` 在启动前执行 `vite build`，并以优化后的前端产物提供服务

## 目标

1. 保持开发环境行为不变。
2. 提供一个单命令的生产启动入口。
3. 生产模式下不依赖 Vite dev server。
4. 生产模式仍保持单体部署，由后端统一承载 API 和前端静态资源。
5. SPA 深链接在生产模式下可直接访问，不因刷新而 404。

## 非目标

- 不改造为前后端分离部署。
- 不引入新的进程管理器或容器编排。
- 不调整现有 SQLite 存储形态。
- 不在本次工作中处理多环境 CDN 发布。

## 现状约束

- 后端当前仅支持 `WEB_MODE=disabled | proxy`。
- `proxy` 模式只适配开发时将页面请求转发到 `http://localhost:5173`。
- 前端是 Vite + React SPA，路由使用 `BrowserRouter`，生产环境必须提供 `index.html` 回退。
- 当前设计面向仓库本地单机部署环境，默认前提是 workspace 依赖已完整安装，不区分 production-only install。

## 方案选型

### 方案 A：新增生产脚本 + 后端静态文件模式（推荐）

- 新增根命令 `npm run deploy`
- 该命令先执行前端构建，再以非 watch 模式启动后端
- 后端新增 `WEB_MODE=static`
- `static` 模式下后端从 `packages/web/dist` 提供静态文件，并对 SPA 路由回退到 `index.html`

优点：

- 符合“单体部署”目标
- 生产环境只保留一个服务入口
- 与当前开发模式边界清晰

缺点：

- 需要在服务端新增静态资源分发逻辑

### 方案 B：构建后继续使用 `vite preview`

优点：实现快。

缺点：

- 更适合本地预览，不适合作为正式部署入口
- 仍然需要额外前端进程
- 不符合“单体生产启动”诉求

### 方案 C：仅去掉 `tsx watch`，不接入静态构建产物

优点：改动最小。

缺点：

- 生产前端资源仍未纳入后端服务链路
- 无法形成真正可部署的生产形态

## 结论

采用方案 A。

## 设计

### 命令层

- 保留根目录 `npm run dev`
- 新增根目录 `npm run deploy`
- 可选补充根目录 `npm run build:web` 作为 `packages/web` 构建别名，避免在生产脚本中写长命令

`npm run deploy` 的职责：

1. 确保 `data/` 目录存在
2. 执行前端生产构建
3. 使用非 watch 模式启动后端
4. 将 `WEB_MODE` 设为 `static`

本次将 `npm run deploy` 定义为“单机简化生产模式”，不是完整的服务端编译发布流水线。也就是说：

- 前端必须执行 `vite build`
- 后端不使用 `tsx watch`
- 后端仍可通过 `tsx` 非 watch 方式运行 TypeScript 源码

运行时前提：

- 仓库必须安装前端构建所需依赖和后端启动所需依赖
- 为避免依赖来源不明确，实施时应将 `tsx` 明确声明到根工作区可用的位置，而不是依赖隐式传递或临时联网下载

这样做符合当前仓库的单体部署诉求，并避免把服务端编译链扩展为本次范围外工作。若后续需要更严格的正式生产构建，可在后续任务中增加 server build 产物与 `node dist/...` 启动路径。

### 后端 Web 模式

将现有模式：

- `disabled`
- `proxy`

扩展为：

- `disabled`
- `proxy`
- `static`

行为定义：

- `disabled`：只提供 API，不处理前端页面
- `proxy`：开发模式，将前端资源请求转发到 Vite dev server
- `static`：生产模式，直接返回构建后的静态文件

### 静态文件服务

在 `static` 模式下：

- `/api/*` 与 `/ai/*` 继续由现有 Hono 路由处理
- 其他请求尝试命中 `packages/web/dist` 中对应文件
- 若请求路径没有匹配到具体文件，则只对满足 SPA 导航特征的请求回退到 `packages/web/dist/index.html`

这能保证 `BrowserRouter` 的前端路由在刷新时仍然返回应用壳。

静态资源处理原则：

- 保留对真实文件的优先命中，例如 `assets/*`、`manifest.webmanifest`、图标文件等
- 仅对非 `/api`、非 `/ai` 的 `GET` / `HEAD` 请求，并且 `Accept` 头表明期望 `text/html` 时回退 `index.html`
- 仅对不带文件扩展名的导航路径执行 SPA fallback
- 对真实静态资源未命中的请求返回 `404`，不能误回退到 `index.html`
- 若构建产物不存在，启动时应尽早失败并给出明确提示

安全与边界规则：

- 请求路径在映射到文件系统前必须做归一化处理，禁止路径穿越到静态目录之外
- 带文件扩展名但未命中的路径，例如 `/foo.js`，一律返回 `404`
- 目录型请求例如 `/assets/` 只有在目录默认文件真实存在时才返回文件，否则按未命中处理
- URL 编码后的路径也必须在归一化后再做存在性判断

### 静态目录解析

不能假设运行时当前工作目录总是仓库根目录，因此生产静态目录必须采用稳定解析策略。

设计要求：

- `deploy.sh` 在启动后端时显式传入 `WEB_DIST_DIR`
- `WEB_DIST_DIR` 指向构建产物目录，默认值由 `deploy.sh` 基于仓库根计算为 `packages/web/dist`
- 服务端只消费 `WEB_DIST_DIR`，不自行回溯仓库结构猜测 dist 位置
- 解析后必须得到规范化绝对路径
- 启动时记录最终解析的静态目录绝对路径
- 若目标目录或 `index.html` 不存在，启动阶段直接失败

实现约束：

- 默认路径来源是 `deploy.sh` 计算出的 `WEB_DIST_DIR`
- 唯一允许覆盖默认值的入口是 `WEB_DIST_DIR`
- 不允许在服务端依赖 `process.cwd()` 或源码目录结构推断静态目录

### Vite 构建前提

本次设计明确只支持站点部署在域名根路径，即前端以 `/` 作为根路径访问。

因此：

- 生产静态资源默认按 Vite 的根路径输出方式提供服务
- 本次不引入子路径部署支持
- 实施时需要确认当前 Vite 配置不会为资源注入错误的子路径前缀

### 脚本组织

建议新增单独生产脚本，例如 `deploy.sh`，避免将开发逻辑和生产逻辑混在 `dev.sh` 中。

脚本职责：

- 创建 `data/`
- 触发前端 build
- 启动 `packages/server/src/index.ts` 的非 watch 版本

建议的命令链为：

```bash
mkdir -p data && npm run build --prefix packages/web && WEB_MODE=static npx tsx packages/server/src/index.ts
```

实际脚本可拆成多步以增强可读性，但行为应与该命令链一致。

脚本契约：

- 使用 `set -euo pipefail`
- 若前端构建失败，脚本立即以非零状态退出
- 脚本应先定位到仓库根目录后再执行命令，不能依赖调用者当前目录碰巧正确
- 最后用 `exec` 启动后端主进程，确保信号直接传递给服务进程
- 默认透传外部环境变量，例如 `PORT`、`HOST`、`NODE_ENV`、`WEB_DIST_DIR`
- 脚本需显式设置 `WEB_DIST_DIR` 为构建产物目录绝对路径

命令语义约束：

- 当前版本将 `npm run deploy` 明确定义为“每次启动前都重新构建前端”的单机简化部署命令
- 本次不提供跳过构建的开关，也不拆分为额外的 `deploy:start`
- 若后续需要更细粒度的启动语义，再单独设计新的脚本层级

最小回滚口径：

- 当前设计不保留多份静态构建产物
- 回滚方式定义为：切回上一份已知可用代码版本后重新执行 `npm run deploy`
- 更完善的产物级回滚不在本次范围内

开发脚本 `dev.sh` 继续保留：

- `tsx watch`
- `vite` dev server
- 健康检查与双进程清理

## 错误处理

- 前端构建失败时，`npm run deploy` 应直接退出
- 若生产模式启动时缺少 `packages/web/dist/index.html`，后端应报错并停止启动，而不是静默降级
- 静态目录解析失败时，应在服务启动阶段 fail fast，而不是等首次请求时才暴露问题
- 健康检查接口 `/api/health` 保持可用，用于部署后验证

## 验证策略

至少验证以下场景：

1. `npm run dev` 仍按当前方式工作
2. `npm run deploy` 会先构建前端，再启动后端
3. 生产模式下访问 `/` 能返回构建后的页面
4. 生产模式下访问 `/messages` 这类 SPA 深链接不会 404
5. `/api/health` 在生产模式下仍正常返回
6. 错误的静态资源 URL 在生产模式下返回 `404`，不会误回退到 `index.html`
7. `WEB_DIST_DIR` 指向错误目录时，服务启动直接失败
8. `packages/web/dist/index.html` 缺失时，服务启动直接失败

最小验收口径：

- 命令级：`npm run deploy` 在前端构建失败时退出非零；成功时后端作为前台主进程运行
- 服务级：`/` 返回 HTML；`/messages` 返回 HTML；不存在的 `.js` 返回 `404`；`/api/health` 返回健康响应
- 启动级：错误静态目录或缺失 `index.html` 时 fail fast

建议的最小验证命令集合：

```bash
npm run build --prefix packages/web
npm run deploy
curl -i http://127.0.0.1:3000/
curl -i http://127.0.0.1:3000/messages
curl -i http://127.0.0.1:3000/api/health
curl -i http://127.0.0.1:3000/assets/does-not-exist.js
```

实施时应至少将静态服务行为校验纳入自动化测试，命令级验证用于本地验收。

## 影响文件

- `package.json`
- `dev.sh`
- 新增生产脚本（如 `deploy.sh`）
- `packages/server/src/index.ts`
- `packages/server/src/app.ts`
- 可能新增 `packages/server/src/web/static.ts` 或同类模块

## 最小实现清单

1. 在根 `package.json` 增加 `deploy` 脚本，指向生产启动脚本。
2. 新增 `deploy.sh`，封装 `data/` 初始化、前端构建和后端生产启动。
3. 在服务端 `WEB_MODE` 联合类型中加入 `static`。
4. 为服务端新增静态文件服务模块，负责：
   - 解析静态目录
   - 返回静态资源
   - 对 HTML 导航请求执行 SPA fallback
5. 在 `app.ts` 中将静态文件路由放在 API 路由之后、最终兜底位置。
6. 在启动阶段校验静态目录和 `index.html` 存在性。
7. 增加覆盖 `static` 模式的测试或等价验证命令。

## 风险与缓解

- 风险：静态文件服务与现有 API 路由冲突
  - 缓解：保持 API 路由注册在前，只对剩余请求处理静态资源
- 风险：SPA fallback 误吞真实静态资源 404
  - 缓解：先检查文件是否存在，仅在未命中时回退 `index.html`
- 风险：生产脚本与开发脚本逻辑漂移
  - 缓解：将环境差异集中到脚本和 `WEB_MODE`，不要复制业务配置
