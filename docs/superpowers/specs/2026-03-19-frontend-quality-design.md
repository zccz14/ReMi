# 前端质量提升与 E2E 测试设计

## 目标

1. 将前端 UI 全量迁移到 shadcn/ui，统一组件风格
2. 引入 Toast 通知系统，补齐错误处理 UI
3. 补充页面级组件测试（React Testing Library）
4. 引入 Playwright 浏览器端到端测试

## 一、shadcn/ui 全量迁移

### 1.1 安装与配置

使用 `shadcn init` 初始化，选择 Vite 模板。项目已有：

- Tailwind CSS v4（`@tailwindcss/vite`）
- `cn()` 工具函数（`clsx` + `tailwind-merge`）
- 路径别名 `@/`（vite.config.ts + tsconfig.json）

需要安装的 shadcn 组件（按使用场景）：

| 组件          | 用途                                        |
| ------------- | ------------------------------------------- |
| `button`      | 替换所有 `<button>` 元素                    |
| `card`        | 替换 Dashboard/Anchors/Settings 的白色卡片  |
| `input`       | 替换所有 `<input>` 元素                     |
| `textarea`    | 替换 ChatInput、AnchorsPage 的 `<textarea>` |
| `badge`       | 锚点来源标记（interview/manual）            |
| `sonner`      | Toast 通知系统                              |
| `dialog`      | 替换删除确认的 `confirm()`                  |
| `select`      | 替换语言切换的 `<select>`                   |
| `skeleton`    | 加载状态占位                                |
| `scroll-area` | 聊天消息列表滚动区域                        |
| `separator`   | 卡片间分割线                                |
| `tooltip`     | 按钮提示                                    |

### 1.2 迁移策略

逐页面迁移，每个页面一个独立 commit：

1. **基础组件层**：先安装 shadcn，生成 `components/ui/` 目录
2. **布局层**：AppShell、NavBar、EphemeralWarning
3. **聊天组件层**：ChatInput、MessageBubble、MessageList、ChatView、ThinkingBlock
4. **页面层**：Dashboard → Interview → Anchors → AvatarChat → Settings → Share

### 1.3 各页面迁移要点

**DashboardPage**：

- 统计卡片 → `Card` + `CardContent`
- 导航按钮 → `Button` (variant: default / outline)
- 加载状态 → `Skeleton`

**InterviewPage**：

- ChatView 内部组件迁移即可，页面本身无额外改动
- 冷启动加载 → `Skeleton`

**AnchorsPage**：

- 搜索框 → `Input`
- 锚点卡片 → `Card`
- 编辑输入 → `Input` + `Textarea`
- 删除确认 `confirm()` → `Dialog`（AlertDialog）
- 添加按钮 → `Button`
- 来源标记 → `Badge`

**AvatarChatPage**：同 InterviewPage，复用迁移后的 ChatView

**SettingsPage**：

- 各设置区块 → `Card`
- 语言选择 `<select>` → shadcn `Select`
- 复制/导出按钮 → `Button`
- 导入输入 → `Input`
- 导入确认 → `Dialog`

**SharePage**：

- QR 码容器 → `Card`
- 复制按钮 → `Button`

## 二、错误处理 UI

### 2.1 Toast 通知系统

使用 shadcn 的 `sonner` 组件（基于 sonner 库），特点：

- 轻量，API 简单：`toast.error("msg")`
- 自动消失，支持 action
- 移动端友好，底部弹出

集成方式：

- 在 `App.tsx` 中添加 `<Toaster />` 组件
- 各页面/hook 通过 `import { toast } from "sonner"` 调用

### 2.2 需要接入 Toast 的位置

| 位置                              | 错误类型     | 处理方式                        |
| --------------------------------- | ------------ | ------------------------------- |
| `useChat.send`                    | SSE/网络错误 | `toast.error(err.message)`      |
| `useChat.onError`                 | 服务端流错误 | `toast.error(err.message)`      |
| `useAnchors.create/update/remove` | API 错误     | try/catch + `toast.error`       |
| `useAnchors.load`                 | 初始加载失败 | try/catch + `toast.error`       |
| `DashboardPage` fetch             | API 错误     | `.catch()` + `toast.error`      |
| `InterviewPage` 冷启动            | SSE 错误     | `.catch()` + `toast.error`      |
| `SettingsPage` 导入               | 密钥无效     | 替换 `alert()` 为 `toast.error` |
| `SharePage`/`SettingsPage` 复制   | 剪贴板失败   | `.catch()` + `toast.error`      |

### 2.3 成功反馈

部分操作也需要成功提示：

- 锚点创建/更新/删除成功 → `toast.success`
- 复制公钥/链接成功 → `toast.success`
- 密钥导入成功 → `toast.success`（替换 `window.location.reload()`）

## 三、页面组件测试

### 3.1 测试基础设施

已安装但未充分使用：

- `@testing-library/react` — `render`, `renderHook`, `screen`, `act`
- `@testing-library/jest-dom` — `toBeInTheDocument` 等 matcher
- `jsdom` — DOM 模拟环境
- `vitest` — 测试框架

需要新增：

- `@testing-library/user-event` — 模拟用户交互（点击、输入等）
- 测试辅助文件 `test/helpers/setup.ts`：全局导入 `@testing-library/jest-dom`
- 测试辅助文件 `test/helpers/test-utils.tsx`：封装 render，包裹 Router + i18n + Auth mock

### 3.2 Mock 策略

**AuthProvider mock**：所有页面依赖 `useAuth()`。测试中用 mock 替换：

```tsx
// 提供 mock apiClient, publicKey, keyStore 等
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => mockAuthState,
}));
```

**ApiClient mock**：mock `get/post/put/del/streamPost` 方法，返回预设数据。

**i18n mock**：使用真实 i18n 实例 + 内存 backend，避免 HTTP 请求。

**react-router mock**：使用 `MemoryRouter` 包裹，设置初始路径。

### 3.3 测试覆盖范围

**UI 组件测试**（`test/components/`）：

- `ChatInput` — 输入、发送、Enter 快捷键、disabled 状态
- `MessageBubble` — user/assistant 消息渲染、样式区别
- `ThinkingBlock` — 展开/折叠
- `MessageList` — 消息渲染、加载更多按钮
- `EphemeralWarning` — 渲染警告文本

**页面测试**（`test/pages/`）：

- `DashboardPage` — 加载统计数据、渲染卡片、导航链接
- `AnchorsPage` — 列表渲染、搜索过滤、添加/编辑/删除
- `SettingsPage` — 公钥显示、复制、语言切换
- `SharePage` — QR 码渲染、复制链接

**Hook 测试**（`test/hooks/`）：

- `useAnchors` — 加载、CRUD 操作、错误处理

## 四、Playwright E2E 测试

### 4.1 基础配置

在项目根目录安装 Playwright：

- `@playwright/test` 作为 devDependency
- 配置文件 `playwright.config.ts`
- 测试目录 `e2e/`

### 4.2 测试环境与自动化策略

E2E 测试需要前后端同时运行。策略：

- Playwright `webServer` 配置启动 `dev.sh`
- Headless 模式运行，基于 DOM/文本断言实现全自动化
- 不依赖 LLM：只测试不需要 LLM 的流程（首页、锚点 CRUD、设置、分享）
- 需要 LLM 的流程（访谈、推理）暂不覆盖

**视觉验证策略**：shadcn 迁移完成后，由人工做一次整体视觉检查（所有页面截图确认）。后续 Playwright 测试仅做功能断言，不做视觉回归。

### 4.3 测试场景

**场景 1：首页加载与导航**

- 打开 `/`，验证 Dashboard 渲染
- 点击底部导航，验证页面切换
- 验证 EphemeralWarning 显示（首次访问无持久化密钥时）

**场景 2：锚点管理**

- 导航到 `/anchors`
- 添加新锚点（输入问题和答案）
- 验证锚点列表包含新项
- 编辑锚点
- 搜索过滤
- 删除锚点

**场景 3：设置页功能**

- 导航到 `/settings`
- 验证公钥显示
- 复制公钥
- 语言切换（中→英→中）

**场景 4：分享页**

- 导航到 `/share`
- 验证 QR 码渲染
- 复制链接

### 4.4 不在 E2E 范围内

- 访谈对话（依赖 LLM，mock 复杂度高）
- 推理对话（同上）
- 密钥导入导出（需要跨 IndexedDB 操作）

## 五、文件变更清单

### 新增文件

```
packages/web/src/components/ui/       # shadcn 生成的组件
packages/web/test/helpers/setup.ts    # 测试 setup
packages/web/test/helpers/test-utils.tsx  # render 封装
packages/web/test/components/         # UI 组件测试
packages/web/test/pages/              # 页面测试
packages/web/test/hooks/use-anchors.test.ts
e2e/                                  # Playwright 测试
playwright.config.ts
```

### 修改文件

```
packages/web/package.json             # 新增依赖
packages/web/src/index.css            # shadcn 样式变量
packages/web/src/App.tsx              # 添加 Toaster
packages/web/src/pages/*.tsx          # 全部 6 个页面
packages/web/src/components/**/*.tsx  # 全部 7 个组件
packages/web/src/hooks/use-chat.ts    # 接入 toast
packages/web/src/hooks/use-anchors.ts # 接入 toast + try/catch
packages/web/vite.config.ts           # 可能的 test 配置调整
```
