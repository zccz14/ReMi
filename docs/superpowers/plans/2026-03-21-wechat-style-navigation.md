# WeChat-Style Navigation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure ReMi from current 4-tab layout to WeChat-style navigation (Messages, Contacts, Discover, Me).

**Architecture:** Server-side: add conversations + contacts API endpoints. Client-side: new NavBar tabs, 5 new pages (Messages, Contacts, Discover, Me, Profile), refactored chat with avatars, updated routing.

**Tech Stack:** React 19, React Router DOM v7, Hono, Drizzle ORM, Tailwind CSS v4, shadcn/ui, Lucide icons, i18next

**Spec:** `docs/superpowers/specs/2026-03-21-wechat-style-navigation-design.md`

---

## File Structure

### New Files

- `packages/server/src/routes/conversations.ts` — conversations + contacts API
- `packages/web/src/pages/MessagesPage.tsx` — conversation list
- `packages/web/src/pages/ContactsPage.tsx` — contacts list
- `packages/web/src/pages/DiscoverPage.tsx` — placeholder
- `packages/web/src/pages/MePage.tsx` — personal center
- `packages/web/src/pages/ProfilePage.tsx` — user profile
- `packages/web/src/pages/StatsPage.tsx` — stats (extracted from Dashboard)
- `packages/web/src/pages/RemiChatPage.tsx` — ReMi chat (from Interview)
- `packages/web/src/components/chat/ChatAvatar.tsx` — reusable avatar component
- `packages/web/src/components/layout/FullScreenLayout.tsx` — layout for non-tab pages

### Modified Files

- `packages/server/src/app.ts` — register new routes
- `packages/web/src/App.tsx` — rewrite route definitions
- `packages/web/src/components/layout/NavBar.tsx` — new 4 tabs
- `packages/web/src/components/layout/AppShell.tsx` — EphemeralWarning extraction
- `packages/web/src/components/chat/MessageBubble.tsx` — add avatar slots
- `packages/web/src/components/chat/ChatView.tsx` — accept avatar props
- `packages/web/src/pages/AvatarChatPage.tsx` — update route param, add header
- `packages/web/src/pages/SharePage.tsx` — update share URL
- `packages/web/public/locales/zh/translation.json` — new keys
- `packages/web/public/locales/en/translation.json` — new keys

### Deleted Files

- `packages/web/src/pages/DashboardPage.tsx` — replaced by StatsPage
- `packages/web/src/pages/InterviewPage.tsx` — replaced by RemiChatPage

---

## Chunk 1: Server API + i18n

### Task 1: Conversations & Contacts API

**Files:**

- Create: `packages/server/src/routes/conversations.ts`
- Modify: `packages/server/src/app.ts:110-113` (add route registration)

- [ ] **Step 1: Create conversations route file**

Create `packages/server/src/routes/conversations.ts` with two endpoints:

1. `GET /:pubKey/conversations` — owner-only. Query last message from `messages` table (interview) and group-by `visitor_key` from `reasoning_messages`. Always include a ReMi entry. Return sorted by `lastMessageAt` desc.

2. `GET /:pubKey/contacts` — owner-only. `SELECT DISTINCT visitor_key FROM reasoning_messages`. Return array of `{ pubKey }`.

Follow the pattern in `anchors.ts`: export `conversationRoutes = new Hono()`, use `requireOwner()`, get DB via `c.get("connMgr").getConnection(pubKey)`.

- [ ] **Step 2: Register route in app.ts**

In `packages/server/src/app.ts`, add import and `.route("/api", conversationRoutes)` after line 113 (after `reasoningRoutes`).

- [ ] **Step 3: Verify server starts**

Run: `cd packages/server && npm run dev`
Expected: server starts without errors.

- [ ] **Step 4: Commit**

```
git add packages/server/src/routes/conversations.ts packages/server/src/app.ts
git commit -m "feat(server): add conversations and contacts API endpoints"
```

### Task 2: i18n Keys

**Files:**

- Modify: `packages/web/public/locales/zh/translation.json`
- Modify: `packages/web/public/locales/en/translation.json`

- [ ] **Step 1: Add new keys to zh translation**

Add these keys to the Chinese translation file:

```json
"nav": { "messages": "消息", "contacts": "通讯录", "discover": "发现", "me": "我" },
"messages": { "title": "消息", "empty": "还没有对话，和 ReMi 聊聊吧！", "startChat": "开始聊天", "tapToStart": "点击开始聊天" },
"contacts": { "title": "通讯录", "empty": "还没有联系人，分享你的链接来认识新朋友吧" },
"discover": { "title": "发现", "subtitle": "发现其他用户，浏览社区", "comingSoon": "即将推出" },
"me": { "title": "我", "stats": "数据统计", "anchors": "灵魂锚点", "share": "分享名片", "settings": "设置" },
"profile": { "title": "个人资料", "sendMessage": "发消息" }
```

Remove old `nav.dashboard`, `nav.interview`, `nav.anchors`, `nav.settings` keys. Keep `dashboard.*`, `settings.*` etc. since those pages still exist.

- [ ] **Step 2: Add same keys to en translation**

Same structure with English values:

```json
"nav": { "messages": "Messages", "contacts": "Contacts", "discover": "Discover", "me": "Me" },
"messages": { "title": "Messages", "empty": "No conversations yet. Chat with ReMi!", "startChat": "Start Chat", "tapToStart": "Tap to start chatting" },
"contacts": { "title": "Contacts", "empty": "No contacts yet. Share your profile link to connect." },
"discover": { "title": "Discover", "subtitle": "Discover users, browse community", "comingSoon": "Coming Soon" },
"me": { "title": "Me", "stats": "Stats", "anchors": "Soul Anchors", "share": "Share Card", "settings": "Settings" },
"profile": { "title": "Profile", "sendMessage": "Send Message" }
```

- [ ] **Step 3: Commit**

```
git add packages/web/public/locales/
git commit -m "feat(i18n): add navigation restructure translation keys"
```

---

## Chunk 2: Layout, NavBar & Routing

### Task 3: ChatAvatar Component

**Files:**

- Create: `packages/web/src/components/chat/ChatAvatar.tsx`

- [ ] **Step 1: Create ChatAvatar**

A reusable avatar component. Props: `pubKey: string`, `name?: string`, `size?: "sm" | "md" | "lg"`, `onClick?: () => void`. Renders a colored rounded square with the first character. Color derived from pubKey hash. ReMi (pubKey === "remi") uses fixed gradient `#667eea` to `#764ba2` with "Ri".

- [ ] **Step 2: Commit**

```
git add packages/web/src/components/chat/ChatAvatar.tsx
git commit -m "feat: add ChatAvatar component"
```

### Task 4: FullScreenLayout Component

**Files:**

- Create: `packages/web/src/components/layout/FullScreenLayout.tsx`

- [ ] **Step 1: Create FullScreenLayout**

Layout for full-screen pages (chat, profile, sub-pages). Structure:

- `div.flex.flex-col.h-screen.max-w-lg.mx-auto`
- Conditionally shows `EphemeralWarning` if `isEphemeral`
- Header with back button (ChevronLeft) + centered title
- `main.flex-1.overflow-hidden` for content via `children`
- No NavBar

Props: `title: string`, `children: ReactNode`, `onBack?: () => void` (defaults to `history.back()`).

- [ ] **Step 2: Commit**

```
git add packages/web/src/components/layout/FullScreenLayout.tsx
git commit -m "feat: add FullScreenLayout component"
```

### Task 5: Update NavBar

**Files:**

- Modify: `packages/web/src/components/layout/NavBar.tsx`

- [ ] **Step 1: Replace navItems array**

Replace the entire `navItems` array (lines 6-11) with:

```tsx
import { MessageSquare, Users, Compass, User, type LucideIcon } from "lucide-react";

const navItems: { path: string; labelKey: string; icon: LucideIcon }[] = [
  { path: "/messages", labelKey: "nav.messages", icon: MessageSquare },
  { path: "/contacts", labelKey: "nav.contacts", icon: Users },
  { path: "/discover", labelKey: "nav.discover", icon: Compass },
  { path: "/me", labelKey: "nav.me", icon: User },
];
```

Remove old imports (`Home`, `Anchor`, `Settings`).

- [ ] **Step 2: Commit**

```
git add packages/web/src/components/layout/NavBar.tsx
git commit -m "feat: update NavBar to WeChat-style tabs"
```

### Task 6: Update AppShell

**Files:**

- Modify: `packages/web/src/components/layout/AppShell.tsx`

- [ ] **Step 1: No structural change needed**

AppShell stays the same (EphemeralWarning + Outlet + NavBar). The `FullScreenLayout` handles the warning for non-tab pages independently.

- [ ] **Step 2: Verify no changes needed, skip commit**

### Task 7: Rewrite App.tsx Routing

**Files:**

- Modify: `packages/web/src/App.tsx`

- [ ] **Step 1: Rewrite route definitions**

Replace the entire `<Routes>` block. New structure:

```tsx
<Routes>
  {/* Tab pages — inside AppShell with NavBar */}
  <Route element={<AppShell />}>
    <Route path="/messages" element={<MessagesPage />} />
    <Route path="/contacts" element={<ContactsPage />} />
    <Route path="/discover" element={<DiscoverPage />} />
    <Route path="/me" element={<MePage />} />
  </Route>
  {/* Full-screen pages — no NavBar */}
  <Route path="/chat/remi" element={<RemiChatPage />} />
  <Route path="/chat/:pubKey" element={<AvatarChatPage />} />
  <Route path="/profile/:pubKey" element={<ProfilePage />} />
  <Route path="/stats" element={<StatsPage />} />
  <Route path="/anchors" element={<AnchorsPage />} />
  <Route path="/share" element={<SharePage />} />
  <Route path="/settings" element={<SettingsPage />} />
  {/* Default redirect */}
  <Route path="*" element={<Navigate to="/messages" replace />} />
</Routes>
```

Update imports: add `Navigate` from react-router-dom, add new page imports, remove `DashboardPage` and `InterviewPage`.

- [ ] **Step 2: Commit**

```
git add packages/web/src/App.tsx
git commit -m "feat: rewrite routing for WeChat-style navigation"
```

---

## Chunk 3: New Pages (Tab Pages)

### Task 8: MessagesPage

**Files:**

- Create: `packages/web/src/pages/MessagesPage.tsx`

- [ ] **Step 1: Create MessagesPage**

Fetches `GET /api/{pubKey}/conversations` via `apiClient.get(apiClient.ownerPath("/conversations"))`. Renders a list of conversation items. Each item: `ChatAvatar` + name + last message preview + time. ReMi entry: if `lastMessage` is null, show `t("messages.tapToStart")`. Empty state: centered text `t("messages.empty")` + button linking to `/chat/remi`. Click item navigates to `/chat/remi` or `/chat/${item.pubKey}` via `useNavigate()`. Title: `t("messages.title")` as `<h1>` at top.

- [ ] **Step 2: Commit**

```
git add packages/web/src/pages/MessagesPage.tsx
git commit -m "feat: add MessagesPage with conversation list"
```

### Task 9: ContactsPage

**Files:**

- Create: `packages/web/src/pages/ContactsPage.tsx`

- [ ] **Step 1: Create ContactsPage**

Fetches `GET /api/{pubKey}/contacts` via `apiClient.get(apiClient.ownerPath("/contacts"))`. Groups contacts by first character of pubKey for section headers. Each item: `ChatAvatar` + truncated pubKey. Click navigates to `/chat/${pubKey}`. Empty state: `t("contacts.empty")`. Title: `t("contacts.title")`.

- [ ] **Step 2: Commit**

```
git add packages/web/src/pages/ContactsPage.tsx
git commit -m "feat: add ContactsPage with alphabetical contact list"
```

### Task 10: DiscoverPage

**Files:**

- Create: `packages/web/src/pages/DiscoverPage.tsx`

- [ ] **Step 1: Create DiscoverPage**

Simple placeholder page. Title `t("discover.title")`. Centered Compass icon (lucide), subtitle `t("discover.subtitle")`, `t("discover.comingSoon")` badge below.

- [ ] **Step 2: Commit**

```
git add packages/web/src/pages/DiscoverPage.tsx
git commit -m "feat: add DiscoverPage placeholder"
```

### Task 11: MePage

**Files:**

- Create: `packages/web/src/pages/MePage.tsx`

- [ ] **Step 1: Create MePage**

Top section: user's own `ChatAvatar` (using own pubKey), truncated pubKey display. Below: a list of menu rows. Each row: Lucide icon + label + ChevronRight + `Link` to target route.

Menu items:

- BarChart3 → `t("me.stats")` → `/stats`
- Anchor → `t("me.anchors")` → `/anchors`
- Share2 → `t("me.share")` → `/share`
- Settings → `t("me.settings")` → `/settings`

Uses `Card` component for the profile section. Menu items use simple `div` rows with `border-b`.

- [ ] **Step 2: Commit**

```
git add packages/web/src/pages/MePage.tsx
git commit -m "feat: add MePage personal center"
```

---

## Chunk 4: Full-Screen Pages + Chat Refactor

### Task 12: ProfilePage

**Files:**

- Create: `packages/web/src/pages/ProfilePage.tsx`

- [ ] **Step 1: Create ProfilePage**

Uses `FullScreenLayout` with `title={t("profile.title")}`. Gets `:pubKey` from `useParams()`. Content: large centered `ChatAvatar` (size="lg"), pubKey (truncated, monospace), and a primary `Button` with MessageSquare icon + `t("profile.sendMessage")` that navigates to `/chat/${pubKey}`.

- [ ] **Step 2: Commit**

```
git add packages/web/src/pages/ProfilePage.tsx
git commit -m "feat: add ProfilePage for user profiles"
```

### Task 13: StatsPage

**Files:**

- Create: `packages/web/src/pages/StatsPage.tsx`
- Delete: `packages/web/src/pages/DashboardPage.tsx`

- [ ] **Step 1: Create StatsPage from DashboardPage**

Copy DashboardPage content. Wrap in `FullScreenLayout` with `title={t("dashboard.title")}`. Remove the three action buttons at bottom (lines 83-95 of DashboardPage: "Start Interview", "View Anchors", "Share Avatar"). Keep only the stats cards and last active display.

- [ ] **Step 2: Delete DashboardPage.tsx**

- [ ] **Step 3: Commit**

```
git add packages/web/src/pages/StatsPage.tsx
git rm packages/web/src/pages/DashboardPage.tsx
git commit -m "feat: replace DashboardPage with StatsPage"
```

### Task 14: Chat Page Refactor — MessageBubble + ChatView

**Files:**

- Modify: `packages/web/src/components/chat/MessageBubble.tsx`
- Modify: `packages/web/src/components/chat/ChatView.tsx`
- Modify: `packages/web/src/components/chat/MessageList.tsx`

- [ ] **Step 1: Add avatar props to MessageBubble**

Update `MessageBubble` to accept optional `avatar?: ReactNode` prop. If provided, render avatar LEFT of assistant bubbles, RIGHT of user bubbles. Wrap in a flex row with gap-2. Avatar is always `flex-shrink-0`.

- [ ] **Step 2: Update ChatView props**

Add to `ChatViewProps`: `myAvatar?: ReactNode`, `theirAvatar?: ReactNode`. Pass these through to `MessageList`.

- [ ] **Step 3: Update MessageList**

Accept `myAvatar` and `theirAvatar` props. When rendering `MessageBubble`, pass `avatar={msg.role === "user" ? myAvatar : theirAvatar}`.

- [ ] **Step 4: Commit**

```
git add packages/web/src/components/chat/
git commit -m "feat: add avatar support to chat components"
```

### Task 15: RemiChatPage

**Files:**

- Create: `packages/web/src/pages/RemiChatPage.tsx`
- Delete: `packages/web/src/pages/InterviewPage.tsx`

- [ ] **Step 1: Create RemiChatPage**

Based on InterviewPage. Wrap in `FullScreenLayout` with `title="ReMi"`. Add `ChatAvatar` instances for ReMi (pubKey="remi") and self (own pubKey from `useAuth()`). Pass `myAvatar` and `theirAvatar` to `ChatView`. Keep all cold-start logic from InterviewPage (lines 31-49).

- [ ] **Step 2: Delete InterviewPage.tsx**

- [ ] **Step 3: Commit**

```
git add packages/web/src/pages/RemiChatPage.tsx
git rm packages/web/src/pages/InterviewPage.tsx
git commit -m "feat: replace InterviewPage with RemiChatPage"
```

### Task 16: Update AvatarChatPage

**Files:**

- Modify: `packages/web/src/pages/AvatarChatPage.tsx`

- [ ] **Step 1: Update AvatarChatPage**

Route changes from `/s/:pubKey` to `/chat/:pubKey`. The `useParams` already reads `pubKey`, so the data logic stays the same. Wrap in `FullScreenLayout` with `title={truncated pubKey}`. Make the title clickable → `navigate(/profile/${pubKey})`. Add `ChatAvatar` for both self and counterpart. Pass to `ChatView` as `myAvatar` and `theirAvatar`. The counterpart's avatar `onClick` navigates to `/profile/${pubKey}`.

- [ ] **Step 2: Commit**

```
git add packages/web/src/pages/AvatarChatPage.tsx
git commit -m "feat: update AvatarChatPage with avatar and header"
```

---

## Chunk 5: Cleanup & Wrappers

### Task 17: Update SharePage URL

**Files:**

- Modify: `packages/web/src/pages/SharePage.tsx:12`

- [ ] **Step 1: Update share URL**

Change line 12 from:

```ts
const shareUrl = `${window.location.origin}/s/${publicKey}`;
```

to:

```ts
const shareUrl = `${window.location.origin}/profile/${publicKey}`;
```

- [ ] **Step 2: Commit**

```
git add packages/web/src/pages/SharePage.tsx
git commit -m "fix: update share URL to /profile/:pubKey"
```

### Task 18: Wrap existing sub-pages with FullScreenLayout

**Files:**

- Modify: `packages/web/src/pages/AnchorsPage.tsx`
- Modify: `packages/web/src/pages/SettingsPage.tsx`
- Modify: `packages/web/src/pages/SharePage.tsx`

- [ ] **Step 1: Wrap AnchorsPage**

Wrap existing content in `FullScreenLayout` with `title={t("anchors.title")}`. Remove the old `<h1>` title since FullScreenLayout provides the header.

- [ ] **Step 2: Wrap SettingsPage**

Same pattern: wrap in `FullScreenLayout` with `title={t("settings.title")}`. Remove old `<h1>`.

- [ ] **Step 3: Wrap SharePage**

Same pattern: wrap in `FullScreenLayout` with `title={t("share.title")}`. Remove old `<h1>`.

- [ ] **Step 4: Commit**

```
git add packages/web/src/pages/AnchorsPage.tsx packages/web/src/pages/SettingsPage.tsx packages/web/src/pages/SharePage.tsx
git commit -m "feat: wrap sub-pages with FullScreenLayout"
```

### Task 19: Final Verification

- [ ] **Step 1: Build check**

Run: `cd packages/web && npm run build`
Expected: no TypeScript errors, successful build.

- [ ] **Step 2: Manual smoke test**

Run: `npm run dev` (root workspace)
Verify:

- `/messages` shows conversation list
- `/contacts` shows contacts
- `/discover` shows placeholder
- `/me` shows personal center with 4 menu items
- Clicking ReMi in messages opens `/chat/remi`
- `/chat/remi` has full chat with cold start
- Back button works (history.back)
- `/profile/:pubKey` shows profile with send button
- All sub-pages (stats, anchors, share, settings) accessible from Me page
- Tab bar visible on 4 tab pages, hidden on others

- [ ] **Step 3: Final commit if any fixes needed**
