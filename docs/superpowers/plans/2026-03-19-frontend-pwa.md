# Frontend PWA Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build ReMi's mobile-first PWA with React, covering all 6 pages (dashboard, interview, anchors, avatar chat, settings, share) with i18n and PWA support.

**Architecture:** SPA using React 19 + Vite, deployed as static site (GitHub Pages / CF Pages). Communicates with backend via signed HTTP requests (ED25519). SSE streaming for real-time chat via fetch + ReadableStream.

**Tech Stack:** React 19, Vite, Tailwind CSS, shadcn/ui, React Router v7, react-i18next, vite-plugin-pwa, qrcode.react, base-x

**Spec:** `docs/superpowers/specs/2026-03-19-frontend-pwa-design.md`

**Important for all agents:** When writing files, keep each write under 1000 characters. Split large files into multiple writes if needed.

---

## File Structure

```
packages/web/
├── index.html                          # SPA entry HTML
├── package.json                        # Package config
├── tsconfig.json                       # TypeScript config
├── vite.config.ts                      # Vite + PWA config
├── tailwind.config.ts                  # Tailwind config
├── postcss.config.js                   # PostCSS for Tailwind
├── components.json                     # shadcn/ui config
├── public/
│   ├── manifest.json                   # PWA manifest
│   └── locales/
│       ├── zh/translation.json         # Chinese translations
│       └── en/translation.json         # English translations
├── src/
│   ├── main.tsx                        # React entry point
│   ├── App.tsx                         # Router + AuthProvider
│   ├── index.css                       # Tailwind imports + globals
│   ├── lib/
│   │   ├── base58.ts                   # Base58 encode/decode (browser-safe)
│   │   ├── signing.ts                  # StringToSign + SHA-256 (Web Crypto)
│   │   ├── api-client.ts              # Signed HTTP client
│   │   ├── sse-client.ts             # SSE stream parser
│   │   ├── i18n.ts                    # i18next config
│   │   └── utils.ts                   # cn() helper for shadcn
│   ├── hooks/
│   │   ├── use-auth.tsx               # AuthContext + useAuth hook
│   │   ├── use-chat.ts               # Chat state management
│   │   └── use-anchors.ts            # Anchor CRUD hook
│   ├── components/
│   │   ├── ui/                        # shadcn/ui components
│   │   ├── chat/
│   │   │   ├── ChatView.tsx           # Chat container
│   │   │   ├── MessageList.tsx        # Scrollable message list
│   │   │   ├── MessageBubble.tsx      # Single message bubble
│   │   │   ├── ThinkingBlock.tsx      # AI thinking display
│   │   │   └── ChatInput.tsx          # Input + send button
│   │   ├── layout/
│   │   │   ├── AppShell.tsx           # Main layout wrapper
│   │   │   └── NavBar.tsx             # Bottom navigation
│   │   └── common/
│   │       └── EphemeralWarning.tsx    # Ephemeral identity banner
│   └── pages/
│       ├── DashboardPage.tsx
│       ├── InterviewPage.tsx
│       ├── AnchorsPage.tsx
│       ├── AvatarChatPage.tsx
│       ├── SettingsPage.tsx
│       └── SharePage.tsx
```

**Modified existing files:**

- `package.json` (root): Add `packages/web` lint scripts
- `packages/server/src/app.ts`: Add CORS middleware

---

## Chunk 1: 基础设施

Package scaffolding, browser-safe signing, API client with tests.

### Task 0: Fix @remi/crypto Browser Compatibility

**Files:**

- Modify: `packages/crypto/src/ed25519.ts`
- Modify: `packages/crypto/package.json`

The `@remi/client` (KeyStore) imports from `@remi/crypto`, which uses `node:crypto` in `ed25519.ts` for `sha512Sync`. This breaks in browsers. Fix by using `@noble/ed25519`'s built-in async sha512 via Web Crypto API (works in both Node.js 20+ and browsers).

- [ ] **Step 1: Update `ed25519.ts` to use universal crypto**

Replace `packages/crypto/src/ed25519.ts`:

```typescript
import * as ed from "@noble/ed25519";
import { base58Encode, base58Decode } from "./base58.js";

// Use @noble/ed25519's built-in sha512 via Web Crypto API (universal: Node 20+ & browsers)
// No need to configure sha512Sync — we use async APIs exclusively.

export function generateKeyPair(): string {
  const privateKey = ed.utils.randomPrivateKey();
  return base58Encode(privateKey);
}

export function getPublicKey(privateKeyBase58: string): string {
  const privateKey = base58Decode(privateKeyBase58);
  // ed.getPublicKey is sync and uses sha512Sync internally.
  // For universal compat, configure sha512Async instead:
  const publicKey = ed.getPublicKey(privateKey);
  return base58Encode(publicKey);
}

export async function sign(message: Uint8Array, privateKeyBase58: string): Promise<string> {
  const privateKey = base58Decode(privateKeyBase58);
  const signature = await ed.signAsync(message, privateKey);
  return base58Encode(signature);
}

export async function verify(
  message: Uint8Array,
  signatureBase58: string,
  publicKeyBase58: string,
): Promise<boolean> {
  const signature = base58Decode(signatureBase58);
  const publicKey = base58Decode(publicKeyBase58);
  return ed.verifyAsync(signature, message, publicKey);
}
```

**Note:** `ed.getPublicKey` is synchronous and requires `sha512Sync`. We have two options:

- (a) Configure `sha512Sync` using a universal polyfill (e.g. `@noble/hashes/sha512`)
- (b) Add an async `getPublicKeyAsync` wrapper

Option (a) is simpler. Add `@noble/hashes` as dependency:

```bash
cd packages/crypto && npm install @noble/hashes
```

Then configure sha512Sync:

```typescript
import { sha512 } from "@noble/hashes/sha512";
ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => {
  const h = sha512.create();
  for (const m of messages) h.update(m);
  return h.digest();
};
```

This replaces `node:crypto` with pure-JS `@noble/hashes` — works in both Node.js and browsers.

- [ ] **Step 2: Run all crypto tests to verify no regression**

```bash
npx vitest run packages/crypto/test/
```

Expected: All tests PASS.

- [ ] **Step 3: Run all server tests (they depend on @remi/crypto)**

```bash
npx vitest run packages/server/test/
```

Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/crypto/
git commit -m "fix(crypto): replace node:crypto with @noble/hashes for browser compatibility"
```

### Task 1: Package Scaffolding

**Files:**

- Create: `packages/web/package.json`
- Create: `packages/web/tsconfig.json`
- Create: `packages/web/vite.config.ts`
- Create: `packages/web/tailwind.config.ts`
- Create: `packages/web/postcss.config.js`
- Create: `packages/web/index.html`
- Create: `packages/web/src/main.tsx`
- Create: `packages/web/src/index.css`
- Create: `packages/web/src/App.tsx`
- Create: `packages/web/src/lib/utils.ts`

- [ ] **Step 1: Create `packages/web/package.json`**

```json
{
  "name": "@remi/web",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0",
    "base-x": "^5.0.0",
    "@remi/client": "*"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "vite": "^6.0.0",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/vite": "^4.0.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create `packages/web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `packages/web/vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
```

- [ ] **Step 4: Create `packages/web/index.html`**

```html
<!doctype html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ReMi - 鉴心</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `packages/web/src/index.css`**

```css
@import "tailwindcss";
```

- [ ] **Step 6: Create `packages/web/src/lib/utils.ts`**

```typescript
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

Note: Add `clsx` and `tailwind-merge` to dependencies:

```bash
cd packages/web && npm install clsx tailwind-merge
```

- [ ] **Step 7: Create `packages/web/src/App.tsx`**

```tsx
export default function App() {
  return <div className="min-h-screen bg-background">Hello ReMi</div>;
}
```

- [ ] **Step 8: Create `packages/web/src/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 9: Install dependencies and verify dev server starts**

```bash
cd packages/web && npm install
npm run dev
```

Expected: Vite dev server starts, shows "Hello ReMi" in browser.

- [ ] **Step 10: Commit**

```bash
git add packages/web/
git commit -m "feat(web): scaffold React + Vite + Tailwind package"
```

### Task 2: Browser-Safe Signing

**Files:**

- Create: `packages/web/src/lib/base58.ts`
- Create: `packages/web/src/lib/signing.ts`
- Test: `packages/web/test/lib/signing.test.ts`

Reference: `packages/server/src/middleware/hono-auth.ts:23` uses `new URL(c.req.url).pathname` (no query string).

- [ ] **Step 1: Write the failing test**

Create `packages/web/test/lib/signing.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { base58Encode, base58Decode } from "../../src/lib/base58";
import { hashBody, buildStringToSign } from "../../src/lib/signing";

describe("base58", () => {
  it("should roundtrip encode/decode", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = base58Encode(data);
    expect(typeof encoded).toBe("string");
    expect(base58Decode(encoded)).toEqual(data);
  });
});

describe("hashBody", () => {
  it("should hash empty body", async () => {
    const hash = await hashBody(undefined);
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  it("should produce consistent hashes", async () => {
    const body = new TextEncoder().encode('{"content":"hello"}');
    const h1 = await hashBody(body);
    const h2 = await hashBody(body);
    expect(h1).toBe(h2);
  });

  it("should differ for different bodies", async () => {
    const b1 = new TextEncoder().encode("a");
    const b2 = new TextEncoder().encode("b");
    expect(await hashBody(b1)).not.toBe(await hashBody(b2));
  });
});

describe("buildStringToSign", () => {
  it("should construct METHOD\\nPATH\\nTIMESTAMP\\nBODYHASH", async () => {
    const result = await buildStringToSign("GET", "/api/abc/anchors", "1700000000000");
    const parts = result.split("\n");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("GET");
    expect(parts[1]).toBe("/api/abc/anchors");
    expect(parts[2]).toBe("1700000000000");
    expect(parts[3].length).toBeGreaterThan(0); // body hash
  });

  it("should include body hash when body provided", async () => {
    const body = new TextEncoder().encode('{"content":"hi"}');
    const withBody = await buildStringToSign("POST", "/api/abc/message", "123", body);
    const withoutBody = await buildStringToSign("POST", "/api/abc/message", "123");
    // Body hashes should differ
    expect(withBody.split("\n")[3]).not.toBe(withoutBody.split("\n")[3]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run packages/web/test/lib/signing.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `packages/web/src/lib/base58.ts`**

```typescript
import baseX from "base-x";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const bs58 = baseX(ALPHABET);

export function base58Encode(data: Uint8Array): string {
  return bs58.encode(data);
}

export function base58Decode(str: string): Uint8Array {
  return bs58.decode(str);
}
```

- [ ] **Step 4: Implement `packages/web/src/lib/signing.ts`**

```typescript
import { base58Encode } from "./base58";

export async function hashBody(body?: Uint8Array): Promise<string> {
  const data = body ?? new Uint8Array(0);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base58Encode(new Uint8Array(hash));
}

export async function buildStringToSign(
  method: string,
  pathname: string,
  timestamp: string,
  body?: Uint8Array,
): Promise<string> {
  const bodyHash = await hashBody(body);
  return `${method}\n${pathname}\n${timestamp}\n${bodyHash}`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run packages/web/test/lib/signing.test.ts
```

Expected: All 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/lib/base58.ts packages/web/src/lib/signing.ts packages/web/test/
git commit -m "feat(web): add browser-safe base58 and signing utils"
```

### Task 3: API Client

**Files:**

- Create: `packages/web/src/lib/api-client.ts`
- Test: `packages/web/test/lib/api-client.test.ts`

Reference: Server auth checks `X-Public-Key`, `X-Timestamp`, `X-Signature` headers. Timestamp window is 30 seconds. Body hash uses SHA-256 base58.

- [ ] **Step 1: Write the failing test**

Create `packages/web/test/lib/api-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiClient } from "../../src/lib/api-client";

// Mock KeyStore
function createMockKeyStore() {
  return {
    getPublicKey: () => "mockPubKey123",
    sign: vi.fn().mockResolvedValue("mockSignature456"),
  };
}

describe("ApiClient", () => {
  let client: ApiClient;
  let mockKeyStore: ReturnType<typeof createMockKeyStore>;

  beforeEach(() => {
    mockKeyStore = createMockKeyStore();
    client = new ApiClient({
      baseUrl: "https://api.test.com",
      keyStore: mockKeyStore as any,
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  it("should send GET with auth headers", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ data: [] }) };
    (fetch as any).mockResolvedValue(mockResponse);

    await client.get("/api/abc/anchors");

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).toBe("https://api.test.com/api/abc/anchors");
    expect(init.headers["X-Public-Key"]).toBe("mockPubKey123");
    expect(init.headers["X-Timestamp"]).toBeDefined();
    expect(init.headers["X-Signature"]).toBe("mockSignature456");
  });

  it("should send POST with body and Content-Type", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ data: {} }) };
    (fetch as any).mockResolvedValue(mockResponse);

    await client.post("/api/abc/reasoning/message", { content: "hello" });

    const [, init] = (fetch as any).mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe('{"content":"hello"}');
  });

  it("should sign with pathname only (no query string)", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ data: {} }) };
    (fetch as any).mockResolvedValue(mockResponse);

    await client.get("/api/abc/anchors?limit=50");

    // Verify sign was called (the stringToSign should use pathname without query)
    expect(mockKeyStore.sign).toHaveBeenCalledOnce();
    const signArg = mockKeyStore.sign.mock.calls[0][0];
    const signStr = new TextDecoder().decode(signArg);
    expect(signStr).toContain("/api/abc/anchors");
    expect(signStr).not.toContain("limit=50");
  });

  it("should throw on non-ok response", async () => {
    const mockResponse = {
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: "FORBIDDEN", message: "Not allowed" }),
    };
    (fetch as any).mockResolvedValue(mockResponse);

    await expect(client.get("/api/abc/anchors")).rejects.toThrow();
  });

  it("should provide ownerPath helper", () => {
    const path = client.ownerPath("/anchors");
    expect(path).toBe("/api/mockPubKey123/anchors");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run packages/web/test/lib/api-client.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/web/src/lib/api-client.ts`**

```typescript
import { buildStringToSign } from "./signing";

interface KeyStoreLike {
  getPublicKey(): string;
  sign(data: Uint8Array): Promise<string>;
}

export interface ApiClientConfig {
  baseUrl: string;
  keyStore: KeyStoreLike;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiClient {
  private baseUrl: string;
  private keyStore: KeyStoreLike;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl;
    this.keyStore = config.keyStore;
  }

  ownerPath(path: string): string {
    return `/api/${this.keyStore.getPublicKey()}${path}`;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  async del(path: string): Promise<void> {
    await this.request<void>("DELETE", path);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const timestamp = String(Date.now());
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const bodyBytes = bodyStr ? new TextEncoder().encode(bodyStr) : undefined;

    // Extract pathname only (no query string) for signing
    const url = new URL(path, "http://placeholder");
    const pathname = url.pathname;

    const stringToSign = await buildStringToSign(method, pathname, timestamp, bodyBytes);
    const signature = await this.keyStore.sign(new TextEncoder().encode(stringToSign));

    const headers: Record<string, string> = {
      "X-Public-Key": this.keyStore.getPublicKey(),
      "X-Timestamp": timestamp,
      "X-Signature": signature,
    };
    if (bodyStr) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: bodyStr,
    });

    if (!response.ok) {
      let errorBody: { error?: string; message?: string } = {};
      try {
        errorBody = await response.json();
      } catch {
        // ignore parse errors
      }
      throw new ApiError(
        response.status,
        errorBody.error ?? "UNKNOWN",
        errorBody.message ?? `HTTP ${response.status}`,
      );
    }

    if (response.status === 204) return undefined as T;
    return response.json();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run packages/web/test/lib/api-client.test.ts
```

Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/api-client.ts packages/web/test/lib/api-client.test.ts
git commit -m "feat(web): add signed API client with auth headers"
```

### Task 4: CORS Backend Configuration

**Files:**

- Modify: `packages/server/src/app.ts:1-30`

- [ ] **Step 1: Add CORS middleware to `packages/server/src/app.ts`**

Add import at top:

```typescript
import { cors } from "hono/cors";
```

After `const app = new Hono();` (line 27), add:

```typescript
// CORS for frontend
const corsOrigins = process.env.CORS_ORIGIN?.split(",").map((s) => s.trim()) ?? [];
if (corsOrigins.length > 0) {
  app.use(
    "/*",
    cors({
      origin: corsOrigins,
      allowHeaders: ["Content-Type", "X-Public-Key", "X-Timestamp", "X-Signature"],
      allowMethods: ["GET", "POST", "PUT", "DELETE"],
    }),
  );
}
```

- [ ] **Step 2: Run existing server tests to verify no regression**

```bash
npx vitest run packages/server/test/
```

Expected: All existing tests PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/app.ts
git commit -m "feat(server): add CORS middleware for frontend"
```

---

## Chunk 2: 对话系统

SSE parsing, Auth context, useChat hook, Chat UI components.

### Task 5: SSE Stream Client

**Files:**

- Create: `packages/web/src/lib/sse-client.ts`
- Test: `packages/web/test/lib/sse-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/web/test/lib/sse-client.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { parseSSEStream } from "../../src/lib/sse-client";

function createMockStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe("parseSSEStream", () => {
  it("should parse thinking event as raw string", async () => {
    const stream = createMockStream(["event: thinking\ndata: I am thinking...\n\n"]);
    const onThinking = vi.fn();
    await parseSSEStream(stream, { onThinking });
    expect(onThinking).toHaveBeenCalledWith("I am thinking...");
  });

  it("should parse token event as raw string", async () => {
    const stream = createMockStream(["event: token\ndata: Hello\n\n"]);
    const onToken = vi.fn();
    await parseSSEStream(stream, { onToken });
    expect(onToken).toHaveBeenCalledWith("Hello");
  });

  it("should parse done event as JSON", async () => {
    const data = JSON.stringify({ messageId: 42, recalledAnchors: ["a1"] });
    const stream = createMockStream([`event: done\ndata: ${data}\n\n`]);
    const onDone = vi.fn();
    await parseSSEStream(stream, { onDone });
    expect(onDone).toHaveBeenCalledWith({ messageId: 42, recalledAnchors: ["a1"] });
  });

  it("should parse error event as JSON", async () => {
    const data = JSON.stringify({ code: "LLM_ERROR", message: "fail" });
    const stream = createMockStream([`event: error\ndata: ${data}\n\n`]);
    const onError = vi.fn();
    await parseSSEStream(stream, { onError });
    expect(onError).toHaveBeenCalledWith({ code: "LLM_ERROR", message: "fail" });
  });

  it("should handle chunked data across multiple reads", async () => {
    const stream = createMockStream(["event: tok", "en\ndata: Hi\n\n"]);
    const onToken = vi.fn();
    await parseSSEStream(stream, { onToken });
    expect(onToken).toHaveBeenCalledWith("Hi");
  });

  it("should handle multiple events in one chunk", async () => {
    const stream = createMockStream([
      "event: token\ndata: A\n\nevent: token\ndata: B\n\n",
    ]);
    const onToken = vi.fn();
    await parseSSEStream(stream, { onToken });
    expect(onToken).toHaveBeenCalledTimes(2);
    expect(onToken).toHaveBeenNthCalledWith(1, "A");
    expect(onToken).toHaveBeenNthCalledWith(2, "B");
  });

  it("should ignore events with empty data", async () => {
    const stream = createMockStream(["event: token\ndata: \n\n"]);
    const onToken = vi.fn();
    await parseSSEStream(stream, { onToken });
    // Empty string is still delivered — parser doesn't filter
    expect(onToken).toHaveBeenCalledWith("");
  });

  it("should handle multi-line data fields", async () => {
    const stream = createMockStream([
      "event: token\ndata: line1\ndata: line2\n\n",
    ]);
    const onToken = vi.fn();
    await parseSSEStream(stream, { onToken });
    expect(onToken).toHaveBeenCalledWith("line1\nline2");
  });

  it("should resolve cleanly when stream aborts", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: token\ndata: hi\n\n"));
        controller.error(new Error("network abort"));
      },
    });
    const onToken = vi.fn();
    // Should not throw — parser handles errors gracefully
    await expect(parseSSEStream(stream, { onToken })).resolves.toBeUndefined();
    expect(onToken).toHaveBeenCalledWith("hi");
  });
});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run packages/web/test/lib/sse-client.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/web/src/lib/sse-client.ts`**

```typescript
export interface SSEHandlers {
  onThinking?: (narrative: string) => void;
  onToken?: (content: string) => void;
  onDone?: (data: Record<string, unknown>) => void;
  onError?: (error: { code: string; message: string }) => void;
}

export async function parseSSEStream(
  stream: ReadableStream<Uint8Array>,
  handlers: SSEHandlers,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch {
        break; // Stream aborted — exit gracefully
      }
      const { done, value } = readResult;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const eventStr of events) {
        if (!eventStr.trim()) continue;
        let eventType = "";
        let data = "";

        const dataLines: string[] = [];
        for (const line of eventStr.split("\n")) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7);
          } else if (line.startsWith("data: ")) {
            dataLines.push(line.slice(6));
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5));
          }
        }
        data = dataLines.join("\n");

        switch (eventType) {
          case "thinking":
            handlers.onThinking?.(data);
            break;
          case "token":
            handlers.onToken?.(data);
            break;
          case "done":
            try {
              handlers.onDone?.(JSON.parse(data));
            } catch {
              // ignore malformed JSON
            }
            break;
          case "error":
            try {
              handlers.onError?.(JSON.parse(data));
            } catch {
              handlers.onError?.({ code: "PARSE_ERROR", message: data });
            }
            break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run packages/web/test/lib/sse-client.test.ts
```

Expected: All 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/sse-client.ts packages/web/test/lib/sse-client.test.ts
git commit -m "feat(web): add SSE stream parser for chat events"
```

### Task 6: Auth Context

**Files:**

- Create: `packages/web/src/hooks/use-auth.tsx`

No unit test for this — it's React context wiring. Tested via page-level integration.

- [ ] **Step 1: Implement `packages/web/src/hooks/use-auth.tsx`**

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { KeyStore } from "@remi/client";
import { ApiClient } from "../lib/api-client";

interface AuthState {
  initialized: boolean;
  publicKey: string;
  isEphemeral: boolean;
  apiClient: ApiClient;
  keyStore: KeyStore;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null);

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const keyStore = new KeyStore();
    keyStore
      .init()
      .then(() => {
        const apiClient = new ApiClient({
          baseUrl: import.meta.env.VITE_API_BASE ?? "http://localhost:3000",
          keyStore,
        });
        setState({
          initialized: true,
          publicKey: keyStore.getPublicKey(),
          isEphemeral: keyStore.isEphemeral(),
          apiClient,
          keyStore,
        });
      })
      .catch((err) => {
        setError(err.message ?? "Failed to initialize identity");
      });
  }, []);

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen text-red-500">{error}</div>
    );
  }

  if (!state) {
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>;
  }

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd packages/web && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/hooks/use-auth.tsx
git commit -m "feat(web): add AuthProvider with KeyStore initialization"
```

### Task 7: useChat Hook

**Files:**

- Create: `packages/web/src/hooks/use-chat.ts`
- Test: `packages/web/test/hooks/use-chat.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/web/test/hooks/use-chat.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChat, type ChatConfig } from "../../src/hooks/use-chat";

function createMockConfig(): ChatConfig {
  return {
    loadMessages: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe("useChat", () => {
  it("should load messages on init", async () => {
    const config = createMockConfig();
    (config.loadMessages as any).mockResolvedValue({
      items: [{ id: 1, role: "user", content: "hello", created_at: 1000 }],
      hasMore: false,
    });
    const { result } = renderHook(() => useChat(config));

    // Wait for initial load
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(config.loadMessages).toHaveBeenCalled();
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].content).toBe("hello");
  });

  it("should add user message optimistically on send", async () => {
    const config = createMockConfig();
    const { result } = renderHook(() => useChat(config));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    act(() => {
      result.current.send("hi");
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].role).toBe("user");
    expect(result.current.messages[0].content).toBe("hi");
    expect(result.current.streaming).toBe(true);
  });

  it("should expose streaming and thinking state", () => {
    const config = createMockConfig();
    const { result } = renderHook(() => useChat(config));
    expect(result.current.streaming).toBe(false);
    expect(result.current.thinking).toBeNull();
  });
});
```

Note: Install `@testing-library/react` first:

```bash
cd packages/web && npm install --save-dev @testing-library/react jsdom @testing-library/jest-dom
```

Add to `vite.config.ts` test config or create `packages/web/vitest.config.ts`:

```typescript
// In packages/web/vite.config.ts, add:
// test: { environment: "jsdom" }
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run packages/web/test/hooks/use-chat.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/web/src/hooks/use-chat.ts`**

```typescript
import { useState, useEffect, useCallback } from "react";
import { type SSEHandlers } from "../lib/sse-client";

export interface ChatMessage {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: number;
}

export interface ChatConfig {
  loadMessages: (params: {
    limit?: number;
    before?: number;
  }) => Promise<{ items: ChatMessage[]; hasMore: boolean }>;
  sendMessage: (content: string, handlers: SSEHandlers) => Promise<void>;
}

export function useChat(config: ChatConfig) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [thinking, setThinking] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    const { items, hasMore: more } = await config.loadMessages({ limit: 50 });
    setMessages(items);
    setHasMore(more);
    setLoaded(true);
  }, [config]);

  useEffect(() => {
    reload();
  }, []);

  const loadMore = useCallback(async () => {
    if (messages.length === 0 || !hasMore) return;
    const oldest = messages[0];
    const { items, hasMore: more } = await config.loadMessages({
      limit: 50,
      before: oldest.id,
    });
    setMessages((prev) => [...items, ...prev]);
    setHasMore(more);
  }, [messages, hasMore, config]);

  const send = useCallback(
    (content: string) => {
      if (streaming) return;

      const userMsg: ChatMessage = {
        id: -Date.now(),
        role: "user",
        content,
        created_at: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setStreaming(true);
      setThinking(null);
      setError(null);

      let assistantContent = "";
      const assistantId = -(Date.now() + 1);

      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: "", created_at: Date.now() },
      ]);

      config
        .sendMessage(content, {
          onThinking: (narrative) => setThinking(narrative),
          onToken: (token) => {
            assistantContent += token;
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: assistantContent } : m)),
            );
          },
          onDone: (data) => {
            const msgId = (data as { messageId?: number }).messageId;
            if (msgId) {
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, id: msgId } : m)),
              );
            }
            setStreaming(false);
            setThinking(null);
          },
          onError: (err) => {
            setError(err.message);
            setStreaming(false);
            setThinking(null);
          },
        })
        .catch((err) => {
          setError(err.message ?? "Unknown error");
          setStreaming(false);
        });
    },
    [streaming, config],
  );

  return { messages, streaming, thinking, hasMore, error, loaded, send, loadMore, reload };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run packages/web/test/hooks/use-chat.test.ts
```

Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/hooks/use-chat.ts packages/web/test/hooks/
git commit -m "feat(web): add useChat hook with streaming support"
```

### Task 8: Chat UI Components

**Files:**

- Create: `packages/web/src/components/chat/ChatInput.tsx`
- Create: `packages/web/src/components/chat/MessageBubble.tsx`
- Create: `packages/web/src/components/chat/ThinkingBlock.tsx`
- Create: `packages/web/src/components/chat/MessageList.tsx`
- Create: `packages/web/src/components/chat/ChatView.tsx`

No unit tests — these are visual components tested via page-level E2E. Verify with `tsc --noEmit`.

- [ ] **Step 1: Create `ChatInput.tsx`**

```tsx
import { useState, type KeyboardEvent } from "react";

interface ChatInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function ChatInput({ onSend, disabled, placeholder }: ChatInputProps) {
  const [value, setValue] = useState("");

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex gap-2 p-3 border-t bg-white">
      <textarea
        className="flex-1 resize-none rounded-lg border px-3 py-2 text-sm min-h-[40px] max-h-[120px]"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? "Type a message..."}
        disabled={disabled}
        rows={1}
      />
      <button
        className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50"
        onClick={handleSend}
        disabled={disabled || !value.trim()}
      >
        Send
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Create `MessageBubble.tsx`**

```tsx
interface MessageBubbleProps {
  role: "user" | "assistant" | "system";
  content: string;
}

export function MessageBubble({ role, content }: MessageBubbleProps) {
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-3`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap ${
          isUser ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-900"
        }`}
      >
        {content}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create `ThinkingBlock.tsx`**

```tsx
import { useState } from "react";

interface ThinkingBlockProps {
  narrative: string;
}

export function ThinkingBlock({ narrative }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mb-3 ml-2 cursor-pointer" onClick={() => setExpanded(!expanded)}>
      <div className="text-xs text-gray-400 italic">
        {expanded ? narrative : `${narrative.slice(0, 60)}...`}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create `MessageList.tsx`**

```tsx
import { useRef, useEffect } from "react";
import { MessageBubble } from "./MessageBubble";
import { ThinkingBlock } from "./ThinkingBlock";
import type { ChatMessage } from "../../hooks/use-chat";

interface MessageListProps {
  messages: ChatMessage[];
  thinking?: string | null;
  hasMore?: boolean;
  onLoadMore?: () => void;
}

export function MessageList({ messages, thinking, hasMore, onLoadMore }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking]);

  const handleScroll = () => {
    if (!containerRef.current || !hasMore || !onLoadMore) return;
    if (containerRef.current.scrollTop === 0) {
      onLoadMore();
    }
  };

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto p-4" onScroll={handleScroll}>
      {hasMore && (
        <button className="w-full text-center text-sm text-gray-400 py-2" onClick={onLoadMore}>
          Load earlier messages
        </button>
      )}
      {messages.map((msg) => (
        <MessageBubble key={msg.id} role={msg.role} content={msg.content} />
      ))}
      {thinking && <ThinkingBlock narrative={thinking} />}
      <div ref={bottomRef} />
    </div>
  );
}
```

- [ ] **Step 5: Create `ChatView.tsx`**

```tsx
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";
import type { ChatMessage } from "../../hooks/use-chat";

interface ChatViewProps {
  messages: ChatMessage[];
  streaming: boolean;
  thinking: string | null;
  hasMore: boolean;
  onSend: (content: string) => void;
  onLoadMore: () => void;
  placeholder?: string;
}

export function ChatView({
  messages,
  streaming,
  thinking,
  hasMore,
  onSend,
  onLoadMore,
  placeholder,
}: ChatViewProps) {
  return (
    <div className="flex flex-col h-full">
      <MessageList
        messages={messages}
        thinking={thinking}
        hasMore={hasMore}
        onLoadMore={onLoadMore}
      />
      <ChatInput onSend={onSend} disabled={streaming} placeholder={placeholder} />
    </div>
  );
}
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd packages/web && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/chat/
git commit -m "feat(web): add Chat UI components (input, bubble, thinking, list, view)"
```

---

## Chunk 3: 页面 + Layout + i18n + PWA

Layout shell, all 6 pages, i18n, PWA config, final wiring.

### Task 9: i18n Setup

**Files:**

- Create: `packages/web/src/lib/i18n.ts`
- Create: `packages/web/public/locales/zh/translation.json`
- Create: `packages/web/public/locales/en/translation.json`

Install: `cd packages/web && npm install react-i18next i18next i18next-http-backend i18next-browser-languagedetector`

- [ ] **Step 1: Create `packages/web/src/lib/i18n.ts`**

```typescript
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import HttpBackend from "i18next-http-backend";
import LanguageDetector from "i18next-browser-languagedetector";

i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: "zh",
    supportedLngs: ["zh", "en"],
    backend: { loadPath: "/locales/{{lng}}/translation.json" },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
    },
    interpolation: { escapeValue: false },
  });

export default i18n;
```

- [ ] **Step 2: Create Chinese translations**

`packages/web/public/locales/zh/translation.json`:

```json
{
  "nav": { "dashboard": "首页", "interview": "访谈", "anchors": "锚点", "settings": "设置" },
  "dashboard": {
    "title": "鉴心",
    "anchors": "灵魂锚点",
    "messages": "访谈消息",
    "lastActive": "最近访谈",
    "startInterview": "开始访谈",
    "viewAnchors": "查看锚点",
    "shareAvatar": "分享分身",
    "never": "暂无"
  },
  "chat": {
    "placeholder": "输入消息...",
    "interviewPlaceholder": "分享你的想法...",
    "loadMore": "加载更多",
    "thinking": "思考中..."
  },
  "anchors": {
    "title": "灵魂锚点",
    "search": "搜索锚点...",
    "noAnswer": "未回答",
    "add": "添加锚点",
    "question": "问题",
    "answer": "答案",
    "save": "保存",
    "delete": "删除",
    "confirmDelete": "确定删除这个锚点？",
    "empty": "暂无锚点"
  },
  "settings": {
    "title": "设置",
    "publicKey": "公钥",
    "copy": "复制",
    "copied": "已复制",
    "exportKey": "导出私钥",
    "exportWarning": "私钥是你的唯一身份凭证，请妥善保管！",
    "importKey": "导入私钥",
    "importPlaceholder": "粘贴 base58 格式私钥...",
    "importConfirm": "导入将覆盖当前密钥，确定继续？",
    "import": "导入",
    "language": "语言",
    "about": "关于"
  },
  "share": {
    "title": "分享分身",
    "description": "扫描二维码与你的分身对话",
    "copyLink": "复制链接",
    "copied": "已复制"
  },
  "common": {
    "cancel": "取消",
    "confirm": "确认",
    "error": "出错了",
    "ephemeralWarning": "当前使用临时身份，关闭浏览器后数据将丢失"
  }
}
```

- [ ] **Step 3: Create English translations**

`packages/web/public/locales/en/translation.json`:

```json
{
  "nav": {
    "dashboard": "Home",
    "interview": "Interview",
    "anchors": "Anchors",
    "settings": "Settings"
  },
  "dashboard": {
    "title": "ReMi",
    "anchors": "Soul Anchors",
    "messages": "Interview Messages",
    "lastActive": "Last Interview",
    "startInterview": "Start Interview",
    "viewAnchors": "View Anchors",
    "shareAvatar": "Share Avatar",
    "never": "Never"
  },
  "chat": {
    "placeholder": "Type a message...",
    "interviewPlaceholder": "Share your thoughts...",
    "loadMore": "Load more",
    "thinking": "Thinking..."
  },
  "anchors": {
    "title": "Soul Anchors",
    "search": "Search anchors...",
    "noAnswer": "No answer",
    "add": "Add Anchor",
    "question": "Question",
    "answer": "Answer",
    "save": "Save",
    "delete": "Delete",
    "confirmDelete": "Delete this anchor?",
    "empty": "No anchors yet"
  },
  "settings": {
    "title": "Settings",
    "publicKey": "Public Key",
    "copy": "Copy",
    "copied": "Copied",
    "exportKey": "Export Private Key",
    "exportWarning": "Your private key is your sole identity credential. Keep it safe!",
    "importKey": "Import Private Key",
    "importPlaceholder": "Paste base58 private key...",
    "importConfirm": "Importing will overwrite your current key. Continue?",
    "import": "Import",
    "language": "Language",
    "about": "About"
  },
  "share": {
    "title": "Share Avatar",
    "description": "Scan QR code to chat with your avatar",
    "copyLink": "Copy Link",
    "copied": "Copied"
  },
  "common": {
    "cancel": "Cancel",
    "confirm": "Confirm",
    "error": "Something went wrong",
    "ephemeralWarning": "Using temporary identity. Data will be lost when browser closes."
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/lib/i18n.ts packages/web/public/locales/
git commit -m "feat(web): add i18n with Chinese and English translations"
```

### Task 10: Layout Components

**Files:**

- Create: `packages/web/src/components/layout/NavBar.tsx`
- Create: `packages/web/src/components/layout/AppShell.tsx`
- Create: `packages/web/src/components/common/EphemeralWarning.tsx`

- [ ] **Step 1: Create `NavBar.tsx`**

```tsx
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

const navItems = [
  { path: "/", labelKey: "nav.dashboard", icon: "🏠" },
  { path: "/interview", labelKey: "nav.interview", icon: "💬" },
  { path: "/anchors", labelKey: "nav.anchors", icon: "⚓" },
  { path: "/settings", labelKey: "nav.settings", icon: "⚙️" },
];

export function NavBar() {
  const { pathname } = useLocation();
  const { t } = useTranslation();

  return (
    <nav className="flex justify-around border-t bg-white py-2">
      {navItems.map((item) => (
        <Link
          key={item.path}
          to={item.path}
          className={`flex flex-col items-center text-xs ${
            pathname === item.path ? "text-blue-600" : "text-gray-500"
          }`}
        >
          <span className="text-lg">{item.icon}</span>
          <span>{t(item.labelKey)}</span>
        </Link>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: Create `EphemeralWarning.tsx`**

```tsx
import { useTranslation } from "react-i18next";

export function EphemeralWarning() {
  const { t } = useTranslation();
  return (
    <div className="bg-yellow-50 text-yellow-800 text-xs text-center py-1 px-2">
      {t("common.ephemeralWarning")}
    </div>
  );
}
```

- [ ] **Step 3: Create `AppShell.tsx`**

```tsx
import { Outlet } from "react-router-dom";
import { NavBar } from "./NavBar";
import { EphemeralWarning } from "../common/EphemeralWarning";
import { useAuth } from "../../hooks/use-auth";

export function AppShell() {
  const { isEphemeral } = useAuth();

  return (
    <div className="flex flex-col h-screen max-w-lg mx-auto">
      {isEphemeral && <EphemeralWarning />}
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
      <NavBar />
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/layout/ packages/web/src/components/common/
git commit -m "feat(web): add layout shell with NavBar and ephemeral warning"
```

### Task 11: Dashboard Page

**Files:**

- Create: `packages/web/src/pages/DashboardPage.tsx`

- [ ] **Step 1: Create `DashboardPage.tsx`**

```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/use-auth";

interface Stats {
  totalAnchors: number;
  totalMessages: number;
  lastActiveAt: number | null;
}

export function DashboardPage() {
  const { t } = useTranslation();
  const { apiClient } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    apiClient
      .get<{ data: Stats }>(apiClient.ownerPath("/interview/status"))
      .then((res) => setStats(res.data));
  }, [apiClient]);

  const formatTime = (ts: number | null) => {
    if (!ts) return t("dashboard.never");
    return new Date(ts).toLocaleDateString();
  };

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-2xl font-bold">{t("dashboard.title")}</h1>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white rounded-xl p-4 shadow-sm">
          <div className="text-2xl font-bold">{stats?.totalAnchors ?? "-"}</div>
          <div className="text-sm text-gray-500">{t("dashboard.anchors")}</div>
        </div>
        <div className="bg-white rounded-xl p-4 shadow-sm">
          <div className="text-2xl font-bold">{stats?.totalMessages ?? "-"}</div>
          <div className="text-sm text-gray-500">{t("dashboard.messages")}</div>
        </div>
      </div>

      <div className="text-sm text-gray-500">
        {t("dashboard.lastActive")}: {formatTime(stats?.lastActiveAt ?? null)}
      </div>

      <div className="space-y-2">
        <Link
          to="/interview"
          className="block w-full text-center bg-blue-600 text-white rounded-lg py-3 font-medium"
        >
          {t("dashboard.startInterview")}
        </Link>
        <div className="grid grid-cols-2 gap-2">
          <Link to="/anchors" className="text-center bg-gray-100 rounded-lg py-3 text-sm">
            {t("dashboard.viewAnchors")}
          </Link>
          <Link to="/share" className="text-center bg-gray-100 rounded-lg py-3 text-sm">
            {t("dashboard.shareAvatar")}
          </Link>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/pages/DashboardPage.tsx
git commit -m "feat(web): add Dashboard page with stats"
```

### Task 12: Interview Page

**Files:**

- Create: `packages/web/src/pages/InterviewPage.tsx`

Uses ChatView + useChat. Special: calls `POST /interview/start` on cold start, `POST /interview/message` for user messages. Uses `ApiClient.streamPost` for SSE (we need to add this method to ApiClient — add it in this task).

- [ ] **Step 1: Add `streamPost` to `api-client.ts`**

Add the following method to the `ApiClient` class in `packages/web/src/lib/api-client.ts`:

```typescript
  async streamPost(
    path: string,
    body: unknown,
    handlers: import("./sse-client").SSEHandlers,
  ): Promise<void> {
    const timestamp = String(Date.now());
    const bodyStr = JSON.stringify(body);
    const bodyBytes = new TextEncoder().encode(bodyStr);

    const url = new URL(path, "http://placeholder");
    const pathname = url.pathname;

    const stringToSign = await buildStringToSign("POST", pathname, timestamp, bodyBytes);
    const signature = await this.keyStore.sign(new TextEncoder().encode(stringToSign));

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Public-Key": this.keyStore.getPublicKey(),
        "X-Timestamp": timestamp,
        "X-Signature": signature,
      },
      body: bodyStr,
    });

    if (!response.ok || !response.body) {
      let errorBody: { error?: string; message?: string } = {};
      try { errorBody = await response.json(); } catch {}
      throw new ApiError(
        response.status,
        errorBody.error ?? "UNKNOWN",
        errorBody.message ?? `HTTP ${response.status}`,
      );
    }

    const { parseSSEStream } = await import("./sse-client");
    await parseSSEStream(response.body, handlers);
  }
```

Also add the import at the top of api-client.ts:

```typescript
import type { SSEHandlers } from "./sse-client";
```

- [ ] **Step 2: Create `InterviewPage.tsx`**

```tsx
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ChatView } from "../components/chat/ChatView";
import { useChat, type ChatConfig } from "../hooks/use-chat";
import { useAuth } from "../hooks/use-auth";

export function InterviewPage() {
  const { t } = useTranslation();
  const { apiClient } = useAuth();
  const coldStartRef = useRef(false);

  const config: ChatConfig = {
    loadMessages: async (params) => {
      const query = new URLSearchParams();
      if (params.limit) query.set("limit", String(params.limit));
      if (params.before) query.set("before", String(params.before));
      const qs = query.toString();
      const path = apiClient.ownerPath(`/interview/messages${qs ? `?${qs}` : ""}`);
      const res = await apiClient.get<{ data: { items: any[]; hasMore: boolean } }>(path);
      return res.data;
    },
    sendMessage: async (content, handlers) => {
      const path = apiClient.ownerPath("/interview/message");
      await apiClient.streamPost(path, { content }, handlers);
    },
  };

  const chat = useChat(config);

  // Cold start: useChat exposes `loaded` — when loaded=true and no messages, trigger /start
  // The /start endpoint returns an SSE stream with the AI's first message.
  // We treat it like a regular sendMessage by passing it through useChat's send flow.
  useEffect(() => {
    if (!chat.loaded || coldStartRef.current || chat.messages.length > 0 || chat.streaming) return;
    coldStartRef.current = true;
    // Trigger cold start via streamPost, then reload messages
    const path = apiClient.ownerPath("/interview/start");
    apiClient.streamPost(
      path,
      {},
      {
        onDone: () => {
          // Reload to get the persisted AI message
          chat.reload();
        },
      },
    );
  }, [chat.loaded, chat.messages.length]);

  return (
    <ChatView
      messages={chat.messages}
      streaming={chat.streaming}
      thinking={chat.thinking}
      hasMore={chat.hasMore}
      onSend={chat.send}
      onLoadMore={chat.loadMore}
      placeholder={t("chat.interviewPlaceholder")}
    />
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd packages/web && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/lib/api-client.ts packages/web/src/pages/InterviewPage.tsx
git commit -m "feat(web): add Interview page with cold start support"
```

### Task 13: Avatar Chat Page

**Files:**

- Create: `packages/web/src/pages/AvatarChatPage.tsx`

- [ ] **Step 1: Create `AvatarChatPage.tsx`**

```tsx
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChatView } from "../components/chat/ChatView";
import { useChat, type ChatConfig } from "../hooks/use-chat";
import { useAuth } from "../hooks/use-auth";

export function AvatarChatPage() {
  const { t } = useTranslation();
  const { pubKey } = useParams<{ pubKey: string }>();
  const { apiClient } = useAuth();

  const config: ChatConfig = {
    loadMessages: async (params) => {
      const query = new URLSearchParams();
      if (params.limit) query.set("limit", String(params.limit));
      if (params.before) query.set("before", String(params.before));
      const qs = query.toString();
      const path = `/api/${pubKey}/reasoning/messages${qs ? `?${qs}` : ""}`;
      const res = await apiClient.get<{ data: { items: any[]; hasMore: boolean } }>(path);
      return res.data;
    },
    sendMessage: async (content, handlers) => {
      const path = `/api/${pubKey}/reasoning/message`;
      await apiClient.streamPost(path, { content }, handlers);
    },
  };

  const chat = useChat(config);

  return (
    <ChatView
      messages={chat.messages}
      streaming={chat.streaming}
      thinking={chat.thinking}
      hasMore={chat.hasMore}
      onSend={chat.send}
      onLoadMore={chat.loadMore}
      placeholder={t("chat.placeholder")}
    />
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/pages/AvatarChatPage.tsx
git commit -m "feat(web): add Avatar Chat page for visitor conversations"
```

### Task 14: Anchors Page

**Files:**

- Create: `packages/web/src/hooks/use-anchors.ts`
- Create: `packages/web/src/pages/AnchorsPage.tsx`

- [ ] **Step 1: Create `use-anchors.ts`**

```typescript
import { useState, useEffect, useCallback } from "react";
import type { ApiClient } from "../lib/api-client";

interface Anchor {
  id: string;
  question: string;
  answer: string | null;
  source: "interview" | "manual";
  createdAt: number;
  updatedAt: number;
}

export function useAnchors(apiClient: ApiClient) {
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const path = apiClient.ownerPath("/anchors?limit=200");
    const res = await apiClient.get<{
      data: { items: Anchor[]; total: number };
    }>(path);
    setAnchors(res.data.items);
    setLoading(false);
  }, [apiClient]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async (question: string, answer?: string) => {
    const path = apiClient.ownerPath("/anchors");
    await apiClient.post(path, { question, answer, source: "manual" });
    await load();
  };

  const update = async (id: string, data: { question?: string; answer?: string | null }) => {
    const path = apiClient.ownerPath(`/anchors/${id}`);
    await apiClient.put(path, data);
    await load();
  };

  const remove = async (id: string) => {
    const path = apiClient.ownerPath(`/anchors/${id}`);
    await apiClient.del(path);
    await load();
  };

  return { anchors, loading, create, update, remove, reload: load };
}
```

- [ ] **Step 2: Create `AnchorsPage.tsx`**

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/use-auth";
import { useAnchors } from "../hooks/use-anchors";

export function AnchorsPage() {
  const { t } = useTranslation();
  const { apiClient } = useAuth();
  const { anchors, loading, create, update, remove } = useAnchors(apiClient);
  const [search, setSearch] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editQ, setEditQ] = useState("");
  const [editA, setEditA] = useState("");

  const filtered = anchors.filter(
    (a) =>
      a.question.toLowerCase().includes(search.toLowerCase()) ||
      (a.answer?.toLowerCase().includes(search.toLowerCase()) ?? false),
  );

  const startEdit = (a: { id: string; question: string; answer: string | null }) => {
    setEditId(a.id);
    setEditQ(a.question);
    setEditA(a.answer ?? "");
  };

  const saveEdit = async () => {
    if (!editId) return;
    await update(editId, { question: editQ, answer: editA || null });
    setEditId(null);
  };

  const [adding, setAdding] = useState(false);
  const [newQ, setNewQ] = useState("");
  const [newA, setNewA] = useState("");

  const handleAdd = async () => {
    if (!newQ.trim()) return;
    await create(newQ.trim(), newA.trim() || undefined);
    setNewQ("");
    setNewA("");
    setAdding(false);
  };

  if (loading) return <div className="p-4 text-center text-gray-400">Loading...</div>;

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 space-y-3">
        <h1 className="text-xl font-bold">{t("anchors.title")}</h1>
        <input
          className="w-full rounded-lg border px-3 py-2 text-sm"
          placeholder={t("anchors.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="flex-1 overflow-y-auto px-4 space-y-3">
        {filtered.length === 0 && (
          <div className="text-center text-gray-400 py-8">{t("anchors.empty")}</div>
        )}
        {filtered.map((a) => (
          <div key={a.id} className="bg-white rounded-xl p-4 shadow-sm">
            {editId === a.id ? (
              <div className="space-y-2">
                <input
                  className="w-full border rounded px-2 py-1 text-sm"
                  value={editQ}
                  onChange={(e) => setEditQ(e.target.value)}
                />
                <textarea
                  className="w-full border rounded px-2 py-1 text-sm"
                  value={editA}
                  onChange={(e) => setEditA(e.target.value)}
                  rows={3}
                />
                <div className="flex gap-2">
                  <button className="text-sm text-blue-600" onClick={saveEdit}>
                    {t("anchors.save")}
                  </button>
                  <button className="text-sm text-gray-400" onClick={() => setEditId(null)}>
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            ) : (
              <div onClick={() => startEdit(a)} className="cursor-pointer">
                <div className="font-medium text-sm">{a.question}</div>
                <div className="text-sm text-gray-500 mt-1">
                  {a.answer || t("anchors.noAnswer")}
                </div>
              </div>
            )}
            {editId !== a.id && (
              <button
                className="text-xs text-red-400 mt-2"
                onClick={() => {
                  if (confirm(t("anchors.confirmDelete"))) remove(a.id);
                }}
              >
                {t("anchors.delete")}
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="p-4 space-y-2">
        {adding ? (
          <div className="bg-white rounded-xl p-4 shadow-sm space-y-2">
            <input
              className="w-full border rounded px-2 py-1 text-sm"
              placeholder={t("anchors.question")}
              value={newQ}
              onChange={(e) => setNewQ(e.target.value)}
              autoFocus
            />
            <textarea
              className="w-full border rounded px-2 py-1 text-sm"
              placeholder={t("anchors.answer")}
              value={newA}
              onChange={(e) => setNewA(e.target.value)}
              rows={3}
            />
            <div className="flex gap-2">
              <button className="text-sm text-blue-600" onClick={handleAdd} disabled={!newQ.trim()}>
                {t("anchors.save")}
              </button>
              <button className="text-sm text-gray-400" onClick={() => setAdding(false)}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <button
            className="w-full bg-blue-600 text-white rounded-lg py-3 text-sm font-medium"
            onClick={() => setAdding(true)}
          >
            + {t("anchors.add")}
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/hooks/use-anchors.ts packages/web/src/pages/AnchorsPage.tsx
git commit -m "feat(web): add Anchors page with CRUD and search"
```

### Task 15: Settings Page

**Files:**

- Create: `packages/web/src/pages/SettingsPage.tsx`

- [ ] **Step 1: Create `SettingsPage.tsx`**

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/use-auth";

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const { publicKey, keyStore } = useAuth();
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [importValue, setImportValue] = useState("");
  const [copied, setCopied] = useState(false);

  const copyPublicKey = async () => {
    await navigator.clipboard.writeText(publicKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExport = () => setShowPrivateKey(!showPrivateKey);

  const handleImport = async () => {
    if (!importValue.trim()) return;
    if (!confirm(t("settings.importConfirm"))) return;
    try {
      await keyStore.importPrivateKey(importValue.trim());
      window.location.reload();
    } catch (err) {
      alert(t("common.error"));
    }
  };

  return (
    <div className="p-4 space-y-6">
      <h1 className="text-xl font-bold">{t("settings.title")}</h1>

      {/* Public Key */}
      <div className="bg-white rounded-xl p-4 shadow-sm space-y-2">
        <div className="text-sm font-medium">{t("settings.publicKey")}</div>
        <div className="text-xs font-mono break-all text-gray-600">{publicKey}</div>
        <button className="text-sm text-blue-600" onClick={copyPublicKey}>
          {copied ? t("settings.copied") : t("settings.copy")}
        </button>
      </div>

      {/* Export */}
      <div className="bg-white rounded-xl p-4 shadow-sm space-y-2">
        <button className="text-sm font-medium text-blue-600" onClick={handleExport}>
          {t("settings.exportKey")}
        </button>
        {showPrivateKey && (
          <div>
            <div className="text-xs text-red-500 mb-1">{t("settings.exportWarning")}</div>
            <div className="text-xs font-mono break-all bg-gray-50 p-2 rounded">
              {keyStore.exportPrivateKey()}
            </div>
          </div>
        )}
      </div>

      {/* Import */}
      <div className="bg-white rounded-xl p-4 shadow-sm space-y-2">
        <div className="text-sm font-medium">{t("settings.importKey")}</div>
        <input
          className="w-full border rounded px-2 py-1 text-xs font-mono"
          placeholder={t("settings.importPlaceholder")}
          value={importValue}
          onChange={(e) => setImportValue(e.target.value)}
        />
        <button
          className="text-sm text-blue-600 disabled:opacity-50"
          onClick={handleImport}
          disabled={!importValue.trim()}
        >
          {t("settings.import")}
        </button>
      </div>

      {/* Language */}
      <div className="bg-white rounded-xl p-4 shadow-sm space-y-2">
        <div className="text-sm font-medium">{t("settings.language")}</div>
        <select
          className="border rounded px-2 py-1 text-sm"
          value={i18n.language}
          onChange={(e) => i18n.changeLanguage(e.target.value)}
        >
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/pages/SettingsPage.tsx
git commit -m "feat(web): add Settings page with key management and language"
```

### Task 16: Share Page

**Files:**

- Create: `packages/web/src/pages/SharePage.tsx`

Install: `cd packages/web && npm install qrcode.react`

- [ ] **Step 1: Create `SharePage.tsx`**

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { useAuth } from "../hooks/use-auth";

export function SharePage() {
  const { t } = useTranslation();
  const { publicKey } = useAuth();
  const [copied, setCopied] = useState(false);

  const shareUrl = `${window.location.origin}/s/${publicKey}`;

  const copyLink = async () => {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="p-4 flex flex-col items-center space-y-6">
      <h1 className="text-xl font-bold">{t("share.title")}</h1>
      <p className="text-sm text-gray-500 text-center">{t("share.description")}</p>

      <div className="bg-white p-6 rounded-2xl shadow-sm">
        <QRCodeSVG value={shareUrl} size={200} />
      </div>

      <div className="text-xs font-mono text-gray-500 break-all text-center max-w-[300px]">
        {shareUrl}
      </div>

      <button
        className="bg-blue-600 text-white rounded-lg px-6 py-3 text-sm font-medium"
        onClick={copyLink}
      >
        {copied ? t("share.copied") : t("share.copyLink")}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/pages/SharePage.tsx
git commit -m "feat(web): add Share page with QR code"
```

### Task 17: Router Wiring + App Assembly

**Files:**

- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/main.tsx`

- [ ] **Step 1: Update `App.tsx` with routes**

Replace `packages/web/src/App.tsx`:

```tsx
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Suspense } from "react";
import { AuthProvider } from "./hooks/use-auth";
import { AppShell } from "./components/layout/AppShell";
import { DashboardPage } from "./pages/DashboardPage";
import { InterviewPage } from "./pages/InterviewPage";
import { AnchorsPage } from "./pages/AnchorsPage";
import { AvatarChatPage } from "./pages/AvatarChatPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SharePage } from "./pages/SharePage";
import "./lib/i18n";

export default function App() {
  return (
    <Suspense
      fallback={<div className="flex items-center justify-center min-h-screen">Loading...</div>}
    >
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/interview" element={<InterviewPage />} />
              <Route path="/anchors" element={<AnchorsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/share" element={<SharePage />} />
            </Route>
            {/* Avatar chat — no NavBar, full screen (uses outer AuthProvider) */}
            <Route
              path="/s/:pubKey"
              element={
                <div className="h-screen max-w-lg mx-auto">
                  <AvatarChatPage />
                </div>
              }
            />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </Suspense>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles and dev server starts**

```bash
cd packages/web && npx tsc --noEmit && npm run dev
```

Expected: No TS errors, dev server starts.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/App.tsx packages/web/src/main.tsx
git commit -m "feat(web): wire up all routes and app assembly"
```

### Task 18: PWA Configuration

**Files:**

- Create: `packages/web/public/manifest.json`
- Modify: `packages/web/vite.config.ts`
- Modify: `packages/web/index.html`

Install: `cd packages/web && npm install -D vite-plugin-pwa`

- [ ] **Step 1: Create `manifest.json`**

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

Note: Create placeholder icon files — `packages/web/public/icons/icon-192.png` and `icon-512.png` as simple 1x1 transparent PNGs for now.

- [ ] **Step 2: Update `vite.config.ts` with PWA plugin**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg}"],
        navigateFallback: "/index.html",
        runtimeCaching: [
          {
            urlPattern: /^https?:\/\/.*\/api\//,
            handler: "NetworkOnly",
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
```

- [ ] **Step 3: Add PWA meta tags to `index.html`**

Add to `<head>`:

```html
<link rel="manifest" href="/manifest.json" />
<meta name="theme-color" content="#1a1a2e" />
<link rel="apple-touch-icon" href="/icons/icon-192.png" />
```

- [ ] **Step 4: Build and verify**

```bash
cd packages/web && npm run build
```

Expected: Build succeeds, outputs to `dist/`.

- [ ] **Step 5: Commit**

```bash
git add packages/web/public/ packages/web/vite.config.ts packages/web/index.html
git commit -m "feat(web): add PWA manifest and service worker config"
```

### Task 19: Final Verification

- [ ] **Step 1: Run all web tests**

```bash
npx vitest run packages/web/test/
```

Expected: All tests PASS.

- [ ] **Step 2: Run TypeScript check**

```bash
cd packages/web && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Run full project test suite**

```bash
npx vitest run
```

Expected: All existing + new tests PASS.

- [ ] **Step 4: Verify build**

```bash
cd packages/web && npm run build
```

Expected: Build succeeds.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(web): complete frontend PWA with all pages"
```
