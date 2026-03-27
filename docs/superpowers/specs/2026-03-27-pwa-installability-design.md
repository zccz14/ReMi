# PWA 可安装性增强设计

## 背景

当前 `packages/web/public/manifest.json` 仅包含最基础的 PWA 字段，已经能被浏览器识别为可安装应用的候选，但安装元数据仍不完整。现有问题主要集中在三类：

1. manifest 中未声明稳定的 `id`，浏览器只能退回使用 `start_url` 推导应用标识。
2. 图标文件与 manifest 声明尺寸不一致，导致安装图标与安装性检查失败。
3. 缺少面向桌面端和移动端的安装截图，浏览器无法展示 richer install UI。

本次改造目标是补齐 manifest 资产与元数据，让应用在浏览器和 Lighthouse 中达到更完整的可安装状态，同时保持范围聚焦在 PWA 资源层，不扩展到新的交互功能开发。

## 目标

- 清除当前 PWA installability 相关的 manifest 告警。
- 为浏览器安装界面补齐稳定 app id、说明文案、图标与截图。
- 保持现有前端页面逻辑不变，不引入新的安装入口 UI。

## 非目标

- 不实现新的 `beforeinstallprompt` 安装按钮或设置页 CTA。
- 不新增离线业务能力或重新设计 service worker 缓存策略。
- 不重做品牌视觉，仅补齐安装所需静态资源。

## 现状

### 当前 manifest

当前 `packages/web/public/manifest.json` 包含：

```json
{
  "name": "ReMi - 鉴心",
  "short_name": "ReMi",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#1a1a2e",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

### 已知缺口

- 缺 `id`
- 缺 `description`
- 缺 `screenshots`
- 图标文件真实尺寸异常
- 没有显式声明更丰富安装展示所依赖的资源集合
- 当前构建链可能同时产出手写 `manifest.json` 与插件生成的 `manifest.webmanifest`，存在 manifest 真源不唯一的风险

## 设计方案

### 1. 保持改动边界在 manifest 与静态资源层

本次只修改以下类型文件：

- `packages/web/public/manifest.json`
- `packages/web/public/icons/*`
- `packages/web/public/screenshots/*`
- 仅当现有构建链无法正确暴露 manifest 或 public 资源时，才允许最小化调整 `packages/web/vite.config.ts` 或 `packages/web/index.html`

不修改业务页面结构、路由、状态管理与安装提示组件。

### 1.1 先收敛到唯一 manifest 真源

本次实现必须先消除“多份 manifest 竞争生效”的不确定性。唯一允许的最终状态是：构建产物中只有一个生效的 manifest 引用，且 Chromium 读取的字段全部来自同一份 manifest。

推荐方案：继续以 `packages/web/public/manifest.json` 作为唯一真源，并关闭 `vite-plugin-pwa` 自动生成或重复注入的 manifest，避免构建后同时出现 `/manifest.json` 与 `/manifest.webmanifest`。

若实现时确认插件无法安全关闭重复 manifest，也可以反向收敛到插件生成 manifest 作为唯一真源；但无论选哪条路径，都必须满足：

- 源头只有一份可维护 manifest 定义
- `index.html` 最终只有一个 `rel="manifest"` 引用
- 验收时检查的 `id`、`description`、`icons`、`screenshots` 全部来自这一个最终 manifest

### 2. 补齐 manifest 元数据

`manifest.json` 将补齐以下字段：

- `id: "/"`，让 app id 与当前生产根路径 `https://remi.zccz14.com/` 保持稳定一致，避免浏览器继续回退到 `start_url` 推导标识
- `description: "AI 个人分身，持续学习你的认知方式并代表你对话与行动。"`
- `screenshots`，至少声明一张移动端截图和一张桌面端宽屏截图

以下字段保持现状，避免扩大行为变更：

- `start_url: "/"`
- `display: "standalone"`
- `theme_color: "#1a1a2e"`
- `background_color: "#ffffff"`

不在本轮引入激进的 `display_override`，因为当前站点未围绕该能力做专门适配。

### 3. 使用真实尺寸图标替换占位资源

保留当前路径协议，继续使用：

- `/icons/icon-192.png`
- `/icons/icon-512.png`

但会重新生成真实的 192x192 与 512x512 PNG 文件，确保：

- 文件像素尺寸与 manifest 中 `sizes` 一致
- manifest 条目包含 `src`、`sizes`、`type`，且 `purpose` 为空或显式为 `any`
- Chromium 的 Manifest 面板将其识别为有效 app icon

`maskable` 图标移到后续任务，不纳入本次范围。

### 4. 增加 richer install UI 所需截图

新增截图目录：

- `packages/web/public/screenshots/`

计划最少放入两张 PNG 截图：

1. 一张移动端截图：建议竖屏，manifest 条目中不写 `form_factor`
2. 一张桌面端截图：横屏宽布局，显式设置 `form_factor: "wide"`

截图约束：

- 文件格式使用 `image/png`
- 截图资源必须可通过 public 根路径访问
- 每个 screenshot 条目至少包含 `src`、`sizes`、`type`
- 桌面截图必须额外包含 `form_factor: "wide"`
- 最终判定不是“文件存在”，而是 Chromium Manifest 面板能识别出 screenshot 条目

截图内容建议优先选择最能体现产品身份的核心界面，例如聊天页、首页或主应用壳层，而不是空白设置页。该建议不影响是否完成本次任务。

### 5. 资源命名与引用策略

命名保持直白，避免后续维护者难以判断用途：

- `packages/web/public/icons/icon-192.png`
- `packages/web/public/icons/icon-512.png`
- `packages/web/public/screenshots/install-mobile.png`
- `packages/web/public/screenshots/install-desktop-wide.png`

manifest 中使用根路径引用，以兼容当前 Vite public 资源组织方式。

`id: "/"` 仅适用于当前生产环境根路径部署；若未来站点改为子路径部署，需要同步调整 `id` 与 `start_url`。

## 数据与流程影响

本次不改变任何业务数据结构，也不改变 service worker 的运行逻辑。影响仅限：

- 浏览器安装面板拿到更完整的应用元数据
- Lighthouse / DevTools 对 installability 的检测通过率提升
- iOS / Android / Desktop 安装入口在视觉层面更完整

## 错误处理与回退

- 若截图资源路径错误，浏览器会忽略截图但不影响应用主功能；构建后必须手动检查截图 URL 可访问。
- 若图标生成失败或尺寸仍错误，安装性告警会继续存在；图标像素检查必须作为验收步骤之一。
- 若发布后出现 manifest 资源路径错误或 installability 回归，直接回退到上一版 `packages/web/public/manifest.json` 与对应 icon/screenshot 资源。
- 若个别非 Chromium 浏览器对 richer install UI 支持有限，属于平台差异，不视为本次失败；本次验收以 Chromium 为基准。

## 验收标准

满足以下条件视为完成：

1. 项目构建后的最终产物中只存在一个生效的 manifest 引用
2. 该唯一 manifest 包含 `id: "/"` 与指定 `description` 文案
3. manifest 中至少存在 2 个 icon 条目，分别指向 `/icons/icon-192.png` 与 `/icons/icon-512.png`，类型为 `image/png`
4. `/icons/icon-192.png` 与 `/icons/icon-512.png` 的真实尺寸分别为 192x192 与 512x512
5. manifest 中至少存在 2 个 screenshot 条目，其中一个为未声明 `form_factor` 的移动端截图，另一个为 `form_factor: "wide"` 的桌面截图
6. 两张 screenshot 资源都可通过 public 路径访问，且 Chromium Manifest 面板能识别出截图条目
7. `npm run build --workspace @remi/web` 成功
8. Chromium 的 Application > Manifest 面板可解析出以下事实，且字段来自上述唯一 manifest：
   - 一个 192x192 PNG icon
   - 一个 512x512 PNG icon
   - 一个未声明 `form_factor` 的移动端 screenshot
   - 一个 `form_factor: "wide"` 的桌面 screenshot

Lighthouse 或 DevTools installability 告警仅作为辅证，不作为唯一放行标准。

## 测试与验证

基准环境：本地 Chromium（Chrome 或等效 Chromium 浏览器最新稳定版）。

### 静态资源验证

- 检查图标文件真实像素尺寸
- 检查截图文件存在且可通过 public 路径访问
- 检查 manifest JSON 结构合法，且字段与设计文档一致

### 构建验证

- 运行前端构建，确认 Vite 能正确打包并生成 PWA 资源

### 浏览器验证

- 在 Chromium 的 Application > Manifest 面板中检查 icon 与 screenshot 识别结果
- 重新运行 Lighthouse 或等效 installability 检查，作为辅助确认
- 以验收标准列出的 manifest 字段、资源尺寸、资源可访问性与 Chromium 解析结果作为最终放行依据

## 后续可选工作

如果后续要继续提升安装转化率，可在独立任务中追加：

- 捕获 `beforeinstallprompt`
- 在设置页或首页增加显式安装 CTA
- 增加 `maskable` 图标与平台特定启动图
- 对安装后的首屏体验做窗口化适配
