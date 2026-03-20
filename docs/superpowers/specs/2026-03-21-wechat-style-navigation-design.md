# WeChat-Style Navigation Restructure

## Summary

Restructure the ReMi web app from the current 4-tab layout (Home, Interview, Anchors, Settings) to a WeChat-inspired layout with tabs: Messages, Contacts, Discover, Me. The Interview feature becomes a chat with a special contact "ReMi". Existing pages (Dashboard, Anchors, Share, Settings) move under the "Me" tab. A new Profile page replaces the old `/s/:pubKey` route.

## Motivation

The current navigation treats Interview as a standalone feature. Reframing it as a chat with ReMi makes the interaction feel more natural and social. The WeChat-style structure also provides clear slots for future social features (Discover) and scales well as more chat partners (other users' Avatars) are added.

## Route Map

All routes are flat (top-level). No nesting.

| Route              | Page          | Tab Bar         | Description                                      |
| ------------------ | ------------- | --------------- | ------------------------------------------------ |
| `/`                | —             | —               | Redirects to `/messages`                         |
| `/messages`        | Messages List | Visible (Tab 1) | All conversations sorted by recent activity      |
| `/contacts`        | Contacts      | Visible (Tab 2) | Other users' Avatars, alphabetical               |
| `/discover`        | Discover      | Visible (Tab 3) | Placeholder for user discovery & community       |
| `/me`              | Me            | Visible (Tab 4) | Profile, stats, anchors, share, settings entries |
| `/chat/remi`       | ReMi Chat     | Hidden          | Interview reframed as chat with ReMi             |
| `/chat/:pubKey`    | Avatar Chat   | Hidden          | Chat with another user's Avatar                  |
| `/profile/:pubKey` | User Profile  | Hidden          | Avatar, name, pubKey, "Send Message" button      |
| `/stats`           | Stats         | Hidden          | Dashboard statistics (from old DashboardPage)    |
| `/anchors`         | Anchors       | Hidden          | Soul anchors management (unchanged)              |
| `/share`           | Share         | Hidden          | QR code / share link (unchanged)                 |
| `/settings`        | Settings      | Hidden          | Key management, language (unchanged)             |

### Removed Routes

- `/s/:pubKey` — removed. Share links point directly to `/profile/:pubKey`.
- `/` as Dashboard — replaced by redirect to `/messages`.
- `/interview` — replaced by `/chat/remi`.

## Bottom Tab Bar

4 tabs with Lucide icons:

| Tab | Route       | Lucide Icon     | Label (zh) | Label (en) |
| --- | ----------- | --------------- | ---------- | ---------- |
| 1   | `/messages` | `MessageSquare` | 消息       | Messages   |
| 2   | `/contacts` | `Users`         | 通讯录     | Contacts   |
| 3   | `/discover` | `Compass`       | 发现       | Discover   |
| 4   | `/me`       | `User`          | 我         | Me         |

Active tab uses `text-primary`; inactive tabs use `text-muted-foreground`. Same styling approach as current NavBar.

## Page Designs

### Messages Page (`/messages`)

A conversation list sorted by most recent activity. Each item shows:

- Avatar (colored square with initial)
- Name
- Last message preview (single line, truncated)
- Timestamp

ReMi always appears in this list (as the first conversation if most recent, or in chronological order otherwise). ReMi is not pinned — it follows the same sorting as all other conversations.

Clicking a conversation navigates to `/chat/remi` or `/chat/:pubKey`.

### Contacts Page (`/contacts`)

Lists other ReMi users' Avatars that the user has chatted with. Organized by lexicographic sort of base58 pubKey, with letter section headers based on the first character of the pubKey.

Each contact shows:

- Avatar (colored square with initial)
- Name

Clicking a contact navigates directly to `/chat/:pubKey` (not Profile).

### Discover Page (`/discover`)

Placeholder page for future features. Shows a centered "Coming Soon" state with description: "Discover other users, browse community, connect with strangers."

Purpose: social discovery — finding new people to connect with, community features, etc.

### Me Page (`/me`)

Top section: user's own avatar, display name, and truncated public key.

Below: a list of menu items, each navigating to a sub-page:

- Stats (BarChart3 icon) → `/stats`
- Soul Anchors (Anchor icon) → `/anchors`
- Share Card (Share2 icon) → `/share`
- Settings (Settings icon) → `/settings`

Each menu item has a right chevron indicator.

### Chat Page (`/chat/remi` and `/chat/:pubKey`)

Full-screen page. Tab bar is hidden.

**Header:**

- Left: back button (ChevronLeft icon), uses `history.back()` to navigate to the previous page
- Center: counterpart's name (centered text)
- Right: empty space (for symmetry)

**Message area:**

- Other person's messages: avatar on the LEFT of the bubble. Avatar is clickable → navigates to `/profile/:pubKey`
- My messages: my avatar on the RIGHT of the bubble
- Bubble styles follow WeChat convention: rounded rectangles, assistant on left, user on right

**Input area:**

- Text input with rounded border
- Send button (SendHorizontal icon)

The existing `ChatView`, `ChatInput`, `MessageList`, `MessageBubble` components will be adapted. The key change is adding avatar display next to each message bubble.

**Architecture: two separate page components** sharing the same chat UI components.

- **RemiChatPage** (`/chat/remi`): uses the Interview backend (`/api/{pubKey}/interview/*`). Contains cold-start auto-greeting logic (if no messages, auto-triggers `POST /api/{pubKey}/interview/start`). Supports SSE streaming, phase display, thinking blocks. ReMi's avatar is a colored square with "Ri" initial, using a fixed brand gradient.
- **AvatarChatPage** (`/chat/:pubKey`): uses the reasoning backend (`/api/{pubKey}/reasoning/*`). No cold-start logic. Simpler initialization.

Both pages render `ChatView` with avatar props. The different initialization and backend logic justifies separate page components rather than one component with conditional branching.

### Profile Page (`/profile/:pubKey`)

Full-screen page. Tab bar is hidden.

**Header:** back button + "Profile" title.

**Content:**

- Large centered avatar
- Name
- Public key (truncated, monospace)
- "Send Message" button → navigates to `/chat/:pubKey`

This page is the landing page for share links and QR codes. It replaces the old `/s/:pubKey` → `AvatarChatPage` flow.

### Stats Page (`/stats`)

Reuses existing DashboardPage content (total anchors, total messages, last active date). Full-screen with back button. No tab bar. The "Start Interview", "View Anchors", and "Share Avatar" action buttons from the old DashboardPage are removed — those entry points now live on the Me page.

## Navigation Flows

**Flow 1 — Daily chat:**
Messages list → tap conversation → Chat page

**Flow 2 — Chat from contacts:**
Contacts → tap contact → Chat page → tap their avatar → Profile

**Flow 3 — Scan/share link:**
`/profile/:pubKey` → Profile page → "Send Message" → Chat page

**Flow 4 — ReMi interview:**
Messages list → tap ReMi → `/chat/remi`

## Component Changes

### Modified Components

- **NavBar** — update 4 tabs: icons (MessageSquare, Users, Compass, User), labels, routes
- **AppShell** — routes inside AppShell get NavBar; chat/profile/sub-pages are outside AppShell
- **App.tsx** — rewrite route definitions per the route map above
- **MessageBubble** — add avatar display next to each bubble (left for assistant, right for user). Avatar is clickable for assistant messages.
- **ChatView** — accept avatar props for both participants, pass to MessageBubble

### New Pages

- **MessagesPage** — conversation list with recent activity sorting
- **ContactsPage** — alphabetical contact list
- **DiscoverPage** — placeholder page
- **MePage** — personal center with menu items
- **ProfilePage** — user profile with "Send Message" CTA

### Renamed/Moved Pages

- **DashboardPage** → **StatsPage** (route: `/stats`, content unchanged)
- **InterviewPage** → absorbed into chat page at `/chat/remi`
- **AvatarChatPage** → absorbed into chat page at `/chat/:pubKey`

### Removed

- `/s/:pubKey` route and any redirect logic

## i18n Keys

New translation keys needed:

```
nav.messages: 消息 / Messages
nav.contacts: 通讯录 / Contacts
nav.discover: 发现 / Discover
nav.me: 我 / Me
messages.title: 消息 / Messages
contacts.title: 通讯录 / Contacts
discover.title: 发现 / Discover
discover.subtitle: 发现其他用户，浏览社区 / Discover users, browse community
discover.comingSoon: 即将推出 / Coming Soon
me.title: 我 / Me
me.stats: 数据统计 / Stats
me.anchors: 灵魂锚点 / Soul Anchors
me.share: 分享名片 / Share Card
me.settings: 设置 / Settings
profile.title: 个人资料 / Profile
profile.sendMessage: 发消息 / Send Message
```

Removed keys: `nav.dashboard`, `nav.interview`, `nav.anchors`, `nav.settings` (settings remains as a page, just not a nav item).

## Data Requirements

### Display Names

Users do not have editable display names in this version. Display names are derived as follows:

- **ReMi**: hardcoded name "ReMi"
- **Other users**: display as truncated pubKey (e.g., `5Hx3k...7eFg`). A future version may add user profile endpoints with display names, but that is out of scope.

Avatar appearance: colored square with the first character of the pubKey (base58). Color is deterministically derived from the pubKey (e.g., hash to a hue). ReMi uses a fixed brand gradient (`#667eea` to `#764ba2`) with "Ri" initial.

### Conversations API

Add a new server endpoint: `GET /api/{pubKey}/conversations`

Returns a list of conversations sorted by most recent activity:

```json
[
  {
    "type": "remi",
    "lastMessage": "那你最近在做什么项目呢？",
    "lastMessageAt": 1774026000
  },
  {
    "type": "avatar",
    "pubKey": "5Hx3k...full-key",
    "lastMessage": "我喜欢旅游和摄影...",
    "lastMessageAt": 1773939600
  }
]
```

Implementation: query the last message from `messages` table (interview/ReMi) and group-by `visitor_key` last messages from `reasoning_messages` table, merge and sort by `lastMessageAt` descending. Note: each user has their own database file, so no owner filter is needed — all records in a given DB belong to that user. The ReMi conversation entry is always included in the response even if no interview has started (with `lastMessage: null` and `lastMessageAt: 0`), so the frontend can always show ReMi in the list.

### Contacts API

Add a new server endpoint: `GET /api/{pubKey}/contacts`

Returns the list of distinct pubKeys the user has chatted with via reasoning endpoints:

```json
[{ "pubKey": "5Hx3k...full-key" }, { "pubKey": "7Yz2m...full-key" }]
```

Implementation: `SELECT DISTINCT visitor_key FROM reasoning_messages`. Each user's data is in their own DB file, so no owner filter is needed. For the initial version, contacts = all visitor_keys with reasoning message history. No explicit add/remove mechanism.

### Empty States

- **Messages page with no conversations**: centered message "No conversations yet. Chat with ReMi to get started!" with a button linking to `/chat/remi`.
- **Contacts page with no contacts**: centered message "No contacts yet. Share your profile link to connect with others."
- **Messages page — ReMi always present**: The Conversations API always returns a ReMi entry (with `lastMessage: null` when no interview exists). The frontend renders this as "Tap to start chatting" preview text.

### EphemeralWarning Banner

The `EphemeralWarning` banner (shown when key is not persisted) currently renders inside `AppShell`. For pages outside AppShell (chat, profile, sub-pages), the banner should also be shown. Move the `EphemeralWarning` to a layout wrapper that covers all authenticated routes, not just AppShell routes.

## Out of Scope

- Discover page content (placeholder only)
- Contact management (add/remove/block)
- User profile editing (display name, avatar image)
- Push notifications / unread badges
- Message search
