# Me 页 PWA 立即更新按钮设计

## 背景

ReMi Web 已经启用 `vite-plugin-pwa` 和 precache，浏览器能够在后台发现并下载新的 service worker 版本。但当前应用内没有一个明确、可信的入口让用户在“新版本已经准备就绪”时立刻切换到新版本。

`Me` 页目前已经承载 PWA 安装入口，适合作为这类客户端能力操作的聚合位置。本次需求是在不改动现有缓存策略和业务接口的前提下，为 `Me` 页增加一个只在“新版本可立即激活”时才显示的 `立即更新` 按钮。

## 目标

- 在 `Me` 页增加一个 `立即更新` 按钮。
- 新版本检查由应用根层在后台执行，不由按钮触发。
- 只有在确实存在可立即激活的新 service worker 时，才显示按钮。
- 用户点击按钮后，应用直接切换到新版本，不增加二次确认。

## 非目标

- 不新增“手动检查更新”按钮或版本号比对页面。
- 不改动 `vite-plugin-pwa` 的 precache 策略、runtime caching 策略或构建产物结构。
- 不新增后端接口、数据库字段或业务数据模型。
- 不在本轮加入更新日志弹窗、灰度发布、埋点分析或版本回滚机制。

## 现状

- `packages/web/vite.config.ts` 已启用 `VitePWA({ registerType: "autoUpdate" })`。
- `packages/web/src/pages/MePage.tsx` 当前已有 PWA 安装入口，但没有更新相关 UI。
- 仓库中尚未存在统一的 PWA 更新状态 provider、hook 或 service worker 注册消费层。
- 当前项目已具备全局 toast 容器，可用于轻量反馈。

## 实现约束

- service worker 的注册入口必须保持单一，不能再手写第二套 `navigator.serviceWorker.register()`。
- 本次实现统一采用 `virtual:pwa-register/react` 提供的 `useRegisterSW` 作为唯一注册 API。
- 为了满足“后台检查 + 用户显式切换”的产品语义，本次将 `packages/web/vite.config.ts` 中的 `registerType` 从 `autoUpdate` 调整为 `prompt`。
- `hasUpdate` 统一映射自 `useRegisterSW` 暴露的 `needRefresh`。
- `applyUpdate()` 统一调用 `useRegisterSW` 暴露的 `updateServiceWorker()`。
- 页面层只消费 provider 暴露出来的状态，不直接接触 service worker 底层注册逻辑。

## 核心设计

### 1. 发现新版本的判定方式

本次不引入业务版本号比对，也不在前端维护独立版本清单。新版本是否可用，完全由 `vite-plugin-pwa` 官方注册层暴露的更新状态判定。

推荐判定链路如下：

1. 应用根层通过 `useRegisterSW` 注册并持有唯一一份更新上下文。
2. 根层通过 `useRegisterSW` 返回的 registration 引用在后台调用 `registration.update()`，请求浏览器检查最新的 service worker 脚本与 workbox precache 清单。
3. 如果发现新的构建版本，浏览器会下载新的 worker。
4. 在 `registerType: "prompt"` 下，新的 worker 进入“需要用户显式刷新”状态时，`useRegisterSW` 会暴露 `needRefresh = true`。
5. `PwaUpdateProvider` 将 `needRefresh` 映射为 `hasUpdate = true`。
6. `Me` 页只以 `hasUpdate` 作为按钮显示依据。

这里不再把 `registration.waiting` 直接写死为页面侧事实源，而是明确依赖插件官方 `needRefresh` / `updateServiceWorker` 语义。这样可以避免 `registerType: "autoUpdate"` 与“用户显式点击立即更新”之间的语义冲突。

对页面来说，按钮语义仍然保持严格：用户看见 `立即更新` 时，点击应当确实能切换到新版本，而不是再次去碰碰运气做检查。

### 2. 架构分层

新增一个应用根层的 PWA 更新状态层，建议命名为 `PwaUpdateProvider`。

职责边界如下：

- `PwaUpdateProvider`
  - 通过 `useRegisterSW` 持有唯一 service worker 更新上下文
  - 后台定时或按时机执行更新检查
  - 将 `needRefresh` 映射为 `hasUpdate`
  - 对外暴露 `applyUpdate()`
  - 对外暴露 `isApplying`
- `MePage`
  - 只消费 `hasUpdate` 和 `applyUpdate()`
  - 只在需要时消费 `isApplying`
  - 不直接调用 `navigator.serviceWorker.register()`
  - 不直接处理 `updatefound`、`controllerchange` 等底层事件

根层统一管理有三个原因：

- service worker 注册与更新检查应尽早发生，不能等到用户进入 `Me` 页才开始。
- 页面层只负责渲染和触发动作，可以避免和 `vite-plugin-pwa` 自动注册逻辑发生双注册或状态竞争。
- 当前仓库已启用插件注册语义，因此必须把 provider 设计成“官方注册层的唯一消费点”，不能旁路插件再注册一次。

`PwaUpdateProvider` 建议和现有 `PwaInstallProvider` 并列挂在 `packages/web/src/App.tsx`，保证所有页面都能共享同一份更新状态。

推荐对外接口如下：

- `hasUpdate: boolean`
- `isApplying: boolean`
- `applyUpdate(): Promise<void>`

provider 内部最小状态机如下：

- 初始化时调用 `useRegisterSW`
- 在 `onRegisteredSW` 或等价回调中缓存唯一 `registration` 引用
- 通过 `checkForUpdate()` 统一执行后台检查，内部调用 `registration.update()`
- 将 `needRefresh` 同步映射为 `hasUpdate`
- `applyUpdate()` 只调用一次官方 `updateServiceWorker()`，不再手写第二套刷新控制逻辑

本轮不要求 provider 暴露更多诊断信息；错误反馈可直接在 provider 内部通过 toast 处理。

### 3. 后台检查更新时机

检查更新由根层后台主动执行，不暴露为用户可见的“检查更新”按钮。推荐时机如下：

- 应用启动后尽快执行一次检查
- 之后按可配置的分钟级间隔轮询检查，建议默认值落在 `1-5` 分钟区间
- 页面从后台切回前台时，额外补一次检查，例如基于 `visibilitychange`

这里的后台检查动作统一命名为 `checkForUpdate()`，仅存在于 `PwaUpdateProvider` 内部：

- App 启动时自动调用一次
- 轮询定时器触发时自动调用
- `visibilitychange` 回到前台时自动调用
- `Me` 页按钮点击时不调用它

若 `registration` 尚未就绪，`checkForUpdate()` 直接 no-op，不报错、不 toast，等待下一次正常检查周期。

这样设计的目的：

- 用户不需要特地进入 `Me` 页触发检查
- 页面长时间驻留时，仍有机会在后台发现新版本
- 用户切回应用时，可以较快看到 `立即更新` 按钮出现

本轮不要求实现复杂的指数退避、网络状态感知或跨标签页协调。只需保证后台检查是持续发生、且不会因为页面未访问 `Me` 页而错过更新发现。

### 4. 按钮显示规则

`Me` 页中的 `立即更新` 按钮遵循严格条件渲染：

- `hasUpdate === false` 时，不显示按钮
- `hasUpdate === true` 时，显示按钮

`hasUpdate` 的唯一来源是根层对官方 `needRefresh` 状态的映射。以下情况均不能让按钮显示：

- 仅仅完成了一次更新检查
- 检查请求成功，但没有新 worker
- 只发现 `installing` worker，尚未进入可激活状态
- service worker 更新流程已经失效或 `needRefresh` 已回到 `false`

这保证按钮不会误导用户，以免出现“看见立即更新，点击却什么都没发生”的体验。

### 5. 立即更新执行链路

`applyUpdate()` 的目标是：在用户点击按钮后，立即让新 worker 接管页面，并刷新到新 precache 版本。

推荐流程：

1. `applyUpdate()` 开始时先读取最新的 `needRefresh` 快照。
2. 若 `needRefresh === false`，则直接判定为“失效失败”：结束流程、清理状态并提示“更新已失效”。
3. 若 `needRefresh === true`，则调用 `updateServiceWorker()`，由官方注册层负责触发 waiting worker 激活。
4. provider 将 `isApplying` 置为 `true`，并把页面刷新权完全交给官方更新动作。
5. provider 不再手写 `controllerchange` 监听，也不再手写第二次 `window.location.reload()`。
6. 若官方更新动作 promise 拒绝或在约定超时时间内未完成，则结束流程、恢复可交互状态并提示失败。

这样做的原因是：

- 插件官方更新动作负责让 waiting worker 立刻进入激活流程，避免手写不兼容的消息协议
- 页面刷新与接管时机都交给插件官方语义处理，避免出现重复刷新或竞态
- 可以确保整个更新流程只有一个刷新触发源

本次不设计确认弹窗。只要按钮可见，就默认它表示“现在点击就会切到新版本”。

#### 5.1 与 `registerType` 的最终方案

当前仓库虽然配置了 `registerType: "autoUpdate"`，但这与“后台发现、用户显式点击后才切换版本”的产品语义不一致。本次 RFC 的最终结论是：

- 将 `registerType` 改为 `prompt`
- 根层统一采用 `useRegisterSW`
- `hasUpdate` 只认 `needRefresh`
- `applyUpdate()` 只调用 `updateServiceWorker()`

不保留 `autoUpdate` 与“显式切换”并存的双语义方案。

### 6. 失败处理与回退

尽管按钮只在存在可切换更新时显示，仍要处理按钮点击瞬间状态失效的边界：

- 如果点击时 `needRefresh` 已为 `false`，则直接将 `hasUpdate` 清回 `false`
- 如果已发出官方更新动作，但在限定时间内未完成，则显示轻量提示，并保持旧页面继续可用
- `applyUpdate()` 执行期间按钮必须进入 disabled / loading 状态，防止重复点击

推荐的用户反馈级别：

- 成功路径不额外 toast，直接刷新进入新版本
- 超时失败路径使用轻量 toast，例如“更新失败，请稍后重试”
- 失效路径使用轻量 toast，例如“更新已失效，请稍后再试”

不允许出现半更新状态，即：不能在未确认新 worker 接管页面时就主动 reload，也不能让页面进入“按钮消失但版本未切换”的不确定中间态。

本轮将失败模型最小化为两类：

- `失效失败`：`applyUpdate()` 开始时读取到 `needRefresh === false`
- `切换超时`：已发起官方更新动作，但在限定时间内未完成

不额外设计“发送 `skipWaiting` 失败但可被可靠感知”的分支，避免要求实现不可验证的 ACK 机制。

### 7. 页面布局与文案

按钮文案固定为：`立即更新`。

放置建议：

- 与当前 `Me` 页中的 PWA 安装入口放在同一能力区块附近
- 保持为全宽主按钮样式，遵循当前 `MePage` 的按钮样式约定
- 更新执行期间按钮显示 loading 或 disabled 态，避免重复提交

显示关系：

- 安装按钮仍按现有规则仅在非 PWA 模式下显示
- 更新按钮只由 `hasUpdate` 控制
- 两者互不互斥，因为即使不是安装态，普通浏览器标签页也可能仍受 service worker 控制并发现新版本

## 数据与流程影响

本次不影响业务数据模型和后端接口。变化集中在前端应用壳层和 `Me` 页交互层：

- 应用根层新增 PWA 更新 provider
- 应用启动后增加后台更新检查与 `needRefresh` 状态监听
- `Me` 页新增一个条件渲染的 `立即更新` 按钮
- 用户点击后通过 service worker 生命周期切换到新版本

## 时序概览

1. 根层 provider 初始化插件官方注册层。
2. provider 在后台执行首次 `checkForUpdate()`，并启动轮询与前台恢复检查。
3. 浏览器发现新版本后，插件注册层暴露“可显式刷新/更新”状态。
4. provider 将其映射为 `hasUpdate = true`。
5. `Me` 页显示 `立即更新` 按钮。
6. 用户点击按钮后，provider 进入 `isApplying = true`，调用官方更新动作。
7. 官方更新动作完成新 worker 激活与页面切换。
8. 页面刷新并切到新版本。

## 验收标准

满足以下条件视为完成：

1. 应用根层会在后台执行 service worker 更新检查。
2. 当没有可立即激活的新 service worker 时，`Me` 页不显示 `立即更新` 按钮。
3. 当插件官方注册层判定存在可显式切换的新版本时，`Me` 页显示 `立即更新` 按钮。
4. 用户点击 `立即更新` 后，不再额外确认，而是直接进入更新流程。
5. 新 worker 接管页面后，页面会自动刷新并切换到新版本资源。
6. 如果更新在点击时已失效，按钮会隐藏并给出轻量失败反馈。
7. 如果更新流程失败或超时，旧页面保持可用，不进入不确定状态。
8. `applyUpdate()` 执行期间，按钮不会被重复触发。
9. 整个应用只存在一份 service worker 注册来源，不会出现双注册。

## 测试与验证

### 测试策略

本轮测试分为三层：provider 状态机单元测试、页面组件测试、手工验证预案。

### 1. Provider 状态机单元测试

- mock 插件官方注册 API 暴露的更新状态与更新动作，验证 provider 能在启动后持有唯一更新上下文
- 验证 provider 会在初始化、轮询和前台恢复时调用 `checkForUpdate()`
- 验证 `registration` 未就绪时调用 `checkForUpdate()` 会直接 no-op，且不报错、不 toast
- 验证只有插件官方“需要刷新/需要更新”状态为真时才会暴露 `hasUpdate = true`
- 验证更新状态消失后 `hasUpdate` 会回到 `false`
- 验证 `applyUpdate()` 期间 `isApplying = true`，结束后恢复
- 验证 `applyUpdate()` 只调用一次官方 `updateServiceWorker()`，不会额外触发第二个刷新源
- 验证点击瞬间 `needRefresh === false` 时，不调用 `updateServiceWorker()`

### 2. 页面组件测试

- 验证 `Me` 页在 `hasUpdate = false` 时不显示 `立即更新` 按钮
- 验证 `Me` 页在 `hasUpdate = true` 时显示 `立即更新` 按钮
- 验证点击按钮后会调用 provider 的 `applyUpdate()`
- 验证点击按钮不会触发 `checkForUpdate()` 或任何“手动检查更新”动作
- 验证 `isApplying = true` 时按钮进入 disabled / loading 态
- 验证按钮双击不会触发两次更新流程

### 3. 边界测试

- 验证按钮点击时更新已失效的回退行为
- 验证官方更新动作超时时不会错误刷新页面

### 4. 手工验证 / E2E 预案

- 通过两次不同构建版本的本地或测试环境部署，验证旧页面在后台发现新版本后才出现 `立即更新`
- 验证点击按钮后当前页会切到新版本，而不是只做一次空检查
- 验证没有新版本时按钮始终不显示

## 后续可选工作

如果后续需要继续完善更新体验，可在独立任务中追加：

- 更新成功或失败埋点
- 多标签页同步更新状态
- 更新日志提示
- 更精细的轮询频率和网络感知策略
