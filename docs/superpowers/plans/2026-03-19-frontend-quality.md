# 前端质量提升实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将前端全量迁移到 shadcn/ui，补齐错误处理 UI，添加组件测试和 Playwright E2E 测试。

**Architecture:** 分三阶段：(1) shadcn 初始化 + 基础组件迁移 + Toast 系统 (2) 页面迁移 + 错误处理接入 (3) 组件测试 + E2E 测试。阶段内任务可并行。

**Tech Stack:** shadcn/ui, Radix UI, Sonner, React Testing Library, Playwright, Vitest

**Spec:** `docs/superpowers/specs/2026-03-19-frontend-quality-design.md`

---

## Chunk 1: shadcn 初始化与基础设施

### Task 1: 初始化 shadcn/ui

**Files:**

- Modify: `packages/web/package.json`
- Modify: `packages/web/src/index.css`
- Modify: `packages/web/tsconfig.json`
- Create: `packages/web/components.json`

- [ ] **Step 1: 在 web 包中运行 shadcn init**

```bash
cd packages/web && npx shadcn@latest init
```

选择：TypeScript, 默认样式, 基色, CSS variables, `@/` 别名。
如果 CLI 交互有问题，手动创建 `components.json`。

- [ ] **Step 2: 验证 components.json 生成**

确认文件存在且 `aliases.components` 指向 `@/components/ui`。

- [ ] **Step 3: 更新 index.css**

shadcn init 会添加 CSS 变量（`--background`, `--foreground` 等）到 index.css。确认 Tailwind v4 兼容。

- [ ] **Step 4: 验证构建通过**

```bash
cd packages/web && npx vite build
```

- [ ] **Step 5: Commit**

```bash
git add packages/web && git commit -m "feat(web): initialize shadcn/ui"
```

### Task 2: 安装 shadcn 基础组件

**Files:**

- Create: `packages/web/src/components/ui/button.tsx`
- Create: `packages/web/src/components/ui/card.tsx`
- Create: `packages/web/src/components/ui/input.tsx`
- Create: `packages/web/src/components/ui/textarea.tsx`
- Create: `packages/web/src/components/ui/badge.tsx`
- Create: `packages/web/src/components/ui/dialog.tsx`
- Create: `packages/web/src/components/ui/select.tsx`
- Create: `packages/web/src/components/ui/skeleton.tsx`
- Create: `packages/web/src/components/ui/scroll-area.tsx`
- Create: `packages/web/src/components/ui/separator.tsx`
- Create: `packages/web/src/components/ui/tooltip.tsx`
- Create: `packages/web/src/components/ui/sonner.tsx`

- [ ] **Step 1: 批量添加组件**

```bash
cd packages/web
npx shadcn@latest add button card input textarea badge dialog select skeleton scroll-area separator tooltip sonner
```

- [ ] **Step 2: 验证组件文件生成**

确认 `src/components/ui/` 下有上述所有 `.tsx` 文件。

- [ ] **Step 3: 验证构建通过**

```bash
cd packages/web && npx vite build
```

- [ ] **Step 4: Commit**

```bash
git add packages/web && git commit -m "feat(web): add shadcn/ui components"
```

### Task 3: Toast 系统 + App.tsx 集成

**Files:**

- Modify: `packages/web/src/App.tsx`

- [ ] **Step 1: 在 App.tsx 添加 Toaster**

在 `<BrowserRouter>` 内部、`<Routes>` 之后添加 `<Toaster />`（来自 sonner 的 shadcn 封装）。

- [ ] **Step 2: 验证 dev server 启动正常**

```bash
cd packages/web && npx vite --port 5174 &
sleep 3 && kill %1
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/App.tsx && git commit -m "feat(web): add Toaster to App"
```

---

## Chunk 2: 布局与聊天组件迁移

### Task 4: EphemeralWarning 迁移

**Files:**

- Modify: `packages/web/src/components/common/EphemeralWarning.tsx`

- [ ] **Step 1: 用 shadcn 样式重写**

使用 `cn()` + shadcn 的 `bg-warning` 语义色替换硬编码 Tailwind 类。保留功能不变。

- [ ] **Step 2: Commit**

```bash
git add -u && git commit -m "refactor(web): migrate EphemeralWarning to shadcn style"
```

### Task 5: NavBar 迁移

**Files:**

- Modify: `packages/web/src/components/layout/NavBar.tsx`

- [ ] **Step 1: 用 Button variant="ghost" 替换 Link 样式**

保留 `Link` 路由功能，用 `cn()` + shadcn 样式变量替换硬编码颜色类。

- [ ] **Step 2: Commit**

```bash
git add -u && git commit -m "refactor(web): migrate NavBar to shadcn style"
```

### Task 6: ChatInput 迁移

**Files:**

- Modify: `packages/web/src/components/chat/ChatInput.tsx`

- [ ] **Step 1: 替换为 shadcn Textarea + Button**

用 `Textarea` 替换 `<textarea>`，用 `Button` 替换 `<button>`。保留 Enter 发送、disabled 逻辑不变。

- [ ] **Step 2: Commit**

```bash
git add -u && git commit -m "refactor(web): migrate ChatInput to shadcn"
```

### Task 7: MessageBubble + ThinkingBlock + MessageList 迁移

**Files:**

- Modify: `packages/web/src/components/chat/MessageBubble.tsx`
- Modify: `packages/web/src/components/chat/ThinkingBlock.tsx`
- Modify: `packages/web/src/components/chat/MessageList.tsx`

- [ ] **Step 1: MessageBubble 使用 cn() 和语义色**

用 `cn()` 替换模板字符串拼接 class。用 shadcn 的 `bg-primary`/`bg-muted` 语义色。

- [ ] **Step 2: ThinkingBlock 使用 cn() 样式**

同上，替换硬编码 Tailwind 类。

- [ ] **Step 3: MessageList 引入 ScrollArea**

用 `ScrollArea` 替换 `overflow-y-auto` 的 div。用 `Button variant="ghost"` 替换加载更多按钮。

- [ ] **Step 4: Commit**

```bash
git add -u && git commit -m "refactor(web): migrate chat components to shadcn"
```

---

## Chunk 3: 页面迁移 + 错误处理

### Task 8: DashboardPage 迁移

**Files:**

- Modify: `packages/web/src/pages/DashboardPage.tsx`

- [ ] **Step 1: 迁移到 shadcn 组件**

- 统计卡片 → `Card` + `CardContent`
- 导航按钮 → `Button` (variant default / outline)
- 加载状态 → `Skeleton`
- 添加 `.catch()` + `toast.error` 到 stats fetch

- [ ] **Step 2: Commit**

```bash
git add -u && git commit -m "refactor(web): migrate DashboardPage to shadcn"
```

### Task 9: AnchorsPage 迁移

**Files:**

- Modify: `packages/web/src/pages/AnchorsPage.tsx`
- Modify: `packages/web/src/hooks/use-anchors.ts`

- [ ] **Step 1: 迁移 AnchorsPage UI**

- 搜索 → `Input`
- 锚点卡片 → `Card`
- 编辑 → `Input` + `Textarea`
- 删除 `confirm()` → `AlertDialog`
- 添加按钮 → `Button`
- 来源 → `Badge`

- [ ] **Step 2: useAnchors 添加 try/catch + toast**

所有 API 调用包裹 try/catch，失败时 `toast.error`。成功时 `toast.success`。

- [ ] **Step 3: Commit**

```bash
git add -u && git commit -m "refactor(web): migrate AnchorsPage to shadcn with error handling"
```

### Task 10: SettingsPage 迁移

**Files:**

- Modify: `packages/web/src/pages/SettingsPage.tsx`

- [ ] **Step 1: 迁移 UI**

- 设置区块 → `Card`
- 语言 `<select>` → shadcn `Select`
- 按钮 → `Button`
- 输入 → `Input`
- `alert()` → `toast.error`
- 复制成功 → `toast.success`

- [ ] **Step 2: Commit**

```bash
git add -u && git commit -m "refactor(web): migrate SettingsPage to shadcn"
```

### Task 11: SharePage 迁移

**Files:**

- Modify: `packages/web/src/pages/SharePage.tsx`

- [ ] **Step 1: 迁移 UI**

- QR 码容器 → `Card`
- 复制按钮 → `Button`
- 复制成功/失败 → `toast`

- [ ] **Step 2: Commit**

```bash
git add -u && git commit -m "refactor(web): migrate SharePage to shadcn"
```

### Task 12: InterviewPage + useChat 错误处理

**Files:**

- Modify: `packages/web/src/pages/InterviewPage.tsx`
- Modify: `packages/web/src/hooks/use-chat.ts`

- [ ] **Step 1: useChat 接入 toast**

在 `onError` 和 `.catch()` 中添加 `toast.error(err.message)`。

- [ ] **Step 2: InterviewPage 冷启动错误处理**

给 `streamPost` 添加 `.catch()` + `toast.error`。

- [ ] **Step 3: Commit**

```bash
git add -u && git commit -m "feat(web): add error handling to chat and interview"
```

### Task 13: 验证全部迁移 + 现有测试通过

- [ ] **Step 1: 运行全部测试**

```bash
npm test
```

- [ ] **Step 2: 验证构建**

```bash
cd packages/web && npx vite build
```

- [ ] **Step 3: Commit (如有修复)**

### 🔍 人工视觉检查点

此时所有页面已迁移到 shadcn。请人工启动 dev server 检查：

1. Dashboard 页 — 卡片、按钮、加载状态
2. Interview 页 — 聊天界面
3. Anchors 页 — 列表、搜索、编辑、删除弹窗
4. Settings 页 — 选择框、按钮
5. Share 页 — QR 码、按钮

---

## Chunk 4: 组件测试

### Task 14: 测试基础设施

**Files:**

- Create: `packages/web/test/helpers/setup.ts`
- Create: `packages/web/test/helpers/test-utils.tsx`
- Modify: `packages/web/package.json` (添加 `@testing-library/user-event`)
- Modify: `packages/web/vite.config.ts` (添加 setupFiles)

- [ ] **Step 1: 安装 user-event**

```bash
cd packages/web && npm i -D @testing-library/user-event
```

- [ ] **Step 2: 创建 setup.ts**

导入 `@testing-library/jest-dom/vitest`。

- [ ] **Step 3: 创建 test-utils.tsx**

封装 `render` 函数，自动包裹 `MemoryRouter` + i18n provider。导出 mock auth state 工厂函数。

- [ ] **Step 4: 配置 vite.config.ts setupFiles**

在 `test` 配置中添加 `setupFiles: ["./test/helpers/setup.ts"]`。

- [ ] **Step 5: 验证现有测试仍通过**

```bash
npm test
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "test(web): add test infrastructure (setup, utils, user-event)"
```

### Task 15: UI 组件测试

**Files:**

- Create: `packages/web/test/components/ChatInput.test.tsx`
- Create: `packages/web/test/components/MessageBubble.test.tsx`
- Create: `packages/web/test/components/ThinkingBlock.test.tsx`
- Create: `packages/web/test/components/MessageList.test.tsx`
- Create: `packages/web/test/components/EphemeralWarning.test.tsx`

- [ ] **Step 1: ChatInput 测试**

测试：渲染、输入文本、点击发送、Enter 发送、Shift+Enter 不发送、disabled 状态。

- [ ] **Step 2: MessageBubble 测试**

测试：user 消息右对齐、assistant 消息左对齐、内容正确渲染。

- [ ] **Step 3: ThinkingBlock 测试**

测试：默认显示截断文本、点击展开完整文本。

- [ ] **Step 4: MessageList 测试**

测试：渲染消息列表、显示加载更多按钮。

- [ ] **Step 5: EphemeralWarning 测试**

测试：渲染警告文本。

- [ ] **Step 6: 运行测试验证**

```bash
npm test
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "test(web): add UI component tests"
```

### Task 16: 页面测试

**Files:**

- Create: `packages/web/test/pages/DashboardPage.test.tsx`
- Create: `packages/web/test/pages/AnchorsPage.test.tsx`
- Create: `packages/web/test/pages/SettingsPage.test.tsx`
- Create: `packages/web/test/pages/SharePage.test.tsx`

- [ ] **Step 1: DashboardPage 测试**

Mock `useAuth`，mock `apiClient.get` 返回 stats。测试：渲染统计、导航链接。

- [ ] **Step 2: AnchorsPage 测试**

Mock `useAuth` + `useAnchors`。测试：列表渲染、搜索过滤、添加锚点。

- [ ] **Step 3: SettingsPage 测试**

Mock `useAuth`。测试：公钥显示、语言切换。

- [ ] **Step 4: SharePage 测试**

Mock `useAuth`。测试：QR 码渲染（验证 QRCodeSVG 存在）、链接显示。

- [ ] **Step 5: 运行测试验证**

```bash
npm test
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "test(web): add page component tests"
```

### Task 17: Hook 测试

**Files:**

- Create: `packages/web/test/hooks/use-anchors.test.ts`

- [ ] **Step 1: useAnchors 测试**

Mock `apiClient`。测试：初始加载、create、update、remove、加载失败 toast。

- [ ] **Step 2: 运行测试验证**

```bash
npm test
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test(web): add useAnchors hook test"
```

---

## Chunk 5: Playwright E2E 测试

### Task 18: Playwright 安装与配置

**Files:**

- Modify: `package.json` (根目录，添加 devDependency + script)
- Create: `playwright.config.ts`
- Create: `e2e/` 目录

- [ ] **Step 1: 安装 Playwright**

```bash
npm i -D @playwright/test && npx playwright install chromium
```

- [ ] **Step 2: 创建 playwright.config.ts**

配置：

- `testDir: './e2e'`
- `webServer`: 启动 `npm run dev`，等待 `http://localhost:5173`
- `use.baseURL: 'http://localhost:5173'`
- headless 模式
- 仅 chromium（移动端视口 `390x844`）

- [ ] **Step 3: 添加 npm script**

在根 `package.json` 添加 `"test:e2e": "playwright test"`。

- [ ] **Step 4: 创建空的 e2e 目录**

```bash
mkdir -p e2e
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "test: add Playwright configuration"
```

### Task 19: E2E — 首页与导航

**Files:**

- Create: `e2e/navigation.spec.ts`

- [ ] **Step 1: 编写导航测试**

测试：

- 打开 `/`，验证 Dashboard 标题可见
- 点击底部"访谈"tab，验证跳转到 `/interview`
- 点击底部"锚点"tab，验证跳转到 `/anchors`
- 点击底部"设置"tab，验证跳转到 `/settings`

- [ ] **Step 2: 运行测试**

```bash
npx playwright test e2e/navigation.spec.ts
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test(e2e): add navigation tests"
```

### Task 20: E2E — 锚点 CRUD

**Files:**

- Create: `e2e/anchors.spec.ts`

- [ ] **Step 1: 编写锚点测试**

测试：

- 导航到 `/anchors`
- 点击添加按钮
- 输入问题和答案，保存
- 验证列表中出现新锚点
- 搜索过滤
- 删除锚点（确认弹窗）

- [ ] **Step 2: 运行测试**

```bash
npx playwright test e2e/anchors.spec.ts
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test(e2e): add anchor CRUD tests"
```

### Task 21: E2E — 设置与分享

**Files:**

- Create: `e2e/settings.spec.ts`

- [ ] **Step 1: 编写设置+分享测试**

测试：

- 导航到 `/settings`，验证公钥显示
- 语言切换（中→英→中），验证 UI 文本变化
- 导航到 `/share`，验证 QR 码存在
- 验证分享链接包含公钥

- [ ] **Step 2: 运行测试**

```bash
npx playwright test e2e/settings.spec.ts
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test(e2e): add settings and share tests"
```

### Task 22: 全量验证

- [ ] **Step 1: 运行全部 vitest 测试**

```bash
npm test
```

- [ ] **Step 2: 运行全部 Playwright 测试**

```bash
npx playwright test
```

- [ ] **Step 3: 验证构建**

```bash
cd packages/web && npx vite build
```

- [ ] **Step 4: 最终 Commit**

```bash
git add -A && git commit -m "test: verify all tests pass after frontend quality improvements"
```
