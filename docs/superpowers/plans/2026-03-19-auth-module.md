# Auth 模块实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现基于 ED25519 密钥对的设备绑定身份系统，包含客户端 KeyStore 和服务端签名验证中间件。

**Architecture:** 共享 crypto 核心库（base58 编解码、ED25519 操作、签名构造），客户端 KeyStore 模块封装密钥管理，服务端 auth 中间件验证每次请求签名。客户端和服务端共享签名构造逻辑确保一致性。

**Tech Stack:** TypeScript, Node.js, Vitest, @noble/ed25519, base-x (base58)

---

## 文件结构

```
packages/
  crypto/                     # 共享 crypto 库
    src/
      base58.ts               # base58 编解码
      ed25519.ts              # ED25519 密钥生成/签名/验证
      signing.ts              # StringToSign 构造 + body hash
      index.ts                # 公共导出
    test/
      base58.test.ts
      ed25519.test.ts
      signing.test.ts
    package.json
    tsconfig.json
  server/                     # 服务端
    src/
      middleware/
        auth.ts               # 签名验证核心逻辑
        role.ts               # 角色判定（本体 vs 第三方）
      index.ts                # 入口（占位）
    test/
      middleware/
        auth.test.ts
        role.test.ts
    package.json
    tsconfig.json
  client/                     # 客户端
    src/
      keystore.ts             # KeyStore 模块
    test/
      keystore.test.ts
    package.json
    tsconfig.json
package.json                  # monorepo 根
tsconfig.base.json            # 共享 TS 配置
vitest.config.ts              # vitest 配置
test/
  integration.test.ts         # 端到端集成测试
```

---

**Scope 说明**：本计划覆盖 Auth 模块的核心密码学库、服务端签名验证、客户端密钥管理。不包含 UI 层（二维码生成、临时身份提示等）和具体 HTTP 框架绑定（Express/Hono 等），这些属于后续 API 层计划。

## Chunk 1: 项目脚手架 + 共享 crypto 库

### Task 1: Monorepo 脚手架

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `packages/crypto/package.json`
- Create: `packages/crypto/tsconfig.json`
- Create: `packages/server/package.json`
- Create: `packages/server/tsconfig.json`
- Create: `packages/client/package.json`
- Create: `packages/client/tsconfig.json`

- [ ] **Step 1: 创建根 package.json**

```json
{
  "name": "remi",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist"
  }
}
```

- [ ] **Step 3: 创建三个包的 package.json 和 tsconfig.json**

`packages/crypto/package.json`:
```json
{
  "name": "@remi/crypto",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@noble/ed25519": "^2.0.0",
    "base-x": "^5.0.0"
  }
}
```

`packages/crypto/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist" },
  "include": ["src"]
}
```

`packages/server/package.json`:
```json
{
  "name": "@remi/server",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./middleware/auth": "./src/middleware/auth.ts",
    "./middleware/role": "./src/middleware/role.ts"
  },
  "dependencies": {
    "@remi/crypto": "workspace:*"
  }
}
```

`packages/server/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist" },
  "include": ["src"]
}
```

`packages/client/package.json`:
```json
{
  "name": "@remi/client",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/keystore.ts",
  "dependencies": {
    "@remi/crypto": "workspace:*"
  }
}
```

`packages/client/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "lib": ["ES2022", "DOM"] },
  "include": ["src"]
}
```

注意：client 的 tsconfig 需要 `"DOM"` lib，因为用到 IndexedDB API。

- [ ] **Step 4: 创建 vitest.config.ts**

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "test/**/*.test.ts",
    ],
  },
});
```

- [ ] **Step 5: 安装依赖**

Run: `npm install`
Expected: node_modules 创建成功，无报错。

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "chore: init monorepo with crypto/server/client packages"
```

### Task 2: base58 编解码

**Files:**
- Create: `packages/crypto/src/base58.ts`
- Create: `packages/crypto/test/base58.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/crypto/test/base58.test.ts
import { describe, it, expect } from "vitest";
import { base58Encode, base58Decode } from "../src/base58.js";

describe("base58", () => {
  it("encodes and decodes round-trip", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    expect(base58Decode(base58Encode(data))).toEqual(data);
  });

  it("encodes known value", () => {
    // "Hello" in ASCII = [72, 101, 108, 108, 111]
    const data = new TextEncoder().encode("Hello");
    const encoded = base58Encode(data);
    expect(typeof encoded).toBe("string");
    expect(encoded.length).toBeGreaterThan(0);
    // 不含 0, O, I, l
    expect(encoded).not.toMatch(/[0OIl]/);
  });

  it("handles empty input", () => {
    const data = new Uint8Array(0);
    expect(base58Decode(base58Encode(data))).toEqual(data);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/crypto/test/base58.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 base58**

```typescript
// packages/crypto/src/base58.ts
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

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/crypto/test/base58.test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(crypto): add base58 encode/decode"
```

### Task 3: ED25519 密钥操作

**Files:**
- Create: `packages/crypto/src/ed25519.ts`
- Create: `packages/crypto/test/ed25519.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/crypto/test/ed25519.test.ts
import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  getPublicKey,
  sign,
  verify,
} from "../src/ed25519.js";

describe("ed25519", () => {
  it("generates a private key as base58 string", () => {
    const privateKey = generateKeyPair();
    expect(typeof privateKey).toBe("string");
    expect(privateKey.length).toBeGreaterThan(0);
  });

  it("derives public key from private key", () => {
    const privateKey = generateKeyPair();
    const publicKey = getPublicKey(privateKey);
    expect(typeof publicKey).toBe("string");
    expect(publicKey).not.toBe(privateKey);
  });

  it("signs and verifies", async () => {
    const privateKey = generateKeyPair();
    const publicKey = getPublicKey(privateKey);
    const message = new TextEncoder().encode("hello");
    const signature = await sign(message, privateKey);
    expect(await verify(message, signature, publicKey)).toBe(true);
  });

  it("rejects tampered message", async () => {
    const privateKey = generateKeyPair();
    const publicKey = getPublicKey(privateKey);
    const message = new TextEncoder().encode("hello");
    const signature = await sign(message, privateKey);
    const tampered = new TextEncoder().encode("world");
    expect(await verify(tampered, signature, publicKey)).toBe(false);
  });

  it("rejects wrong public key", async () => {
    const priv1 = generateKeyPair();
    const priv2 = generateKeyPair();
    const pub2 = getPublicKey(priv2);
    const message = new TextEncoder().encode("hello");
    const signature = await sign(message, priv1);
    expect(await verify(message, signature, pub2)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/crypto/test/ed25519.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 ed25519**

```typescript
// packages/crypto/src/ed25519.ts
import * as ed from "@noble/ed25519";
import { base58Encode, base58Decode } from "./base58.js";

export function generateKeyPair(): string {
  const privateKey = ed.utils.randomPrivateKey();
  return base58Encode(privateKey);
}

export function getPublicKey(privateKeyBase58: string): string {
  const privateKey = base58Decode(privateKeyBase58);
  const publicKey = ed.getPublicKey(privateKey);
  return base58Encode(publicKey);
}

export async function sign(
  message: Uint8Array,
  privateKeyBase58: string
): Promise<string> {
  const privateKey = base58Decode(privateKeyBase58);
  const signature = await ed.signAsync(message, privateKey);
  return base58Encode(signature);
}

export async function verify(
  message: Uint8Array,
  signatureBase58: string,
  publicKeyBase58: string
): Promise<boolean> {
  const signature = base58Decode(signatureBase58);
  const publicKey = base58Decode(publicKeyBase58);
  return ed.verifyAsync(signature, message, publicKey);
}
```

注意：使用 `@noble/ed25519` v2 的 `signAsync`/`verifyAsync` API。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/crypto/test/ed25519.test.ts`
Expected: 5 tests PASS

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(crypto): add ed25519 key generation, sign, verify"
```

### Task 4: 签名构造（StringToSign + body hash）

**Files:**
- Create: `packages/crypto/src/signing.ts`
- Create: `packages/crypto/test/signing.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/crypto/test/signing.test.ts
import { describe, it, expect } from "vitest";
import { buildStringToSign, hashBody } from "../src/signing.js";

describe("hashBody", () => {
  it("hashes non-empty body", async () => {
    const body = new TextEncoder().encode('{"key":"value"}');
    const hash = await hashBody(body);
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  it("hashes empty body deterministically", async () => {
    const hash1 = await hashBody(undefined);
    const hash2 = await hashBody(null);
    const hash3 = await hashBody(new Uint8Array(0));
    expect(hash1).toBe(hash2);
    expect(hash2).toBe(hash3);
  });
});

describe("buildStringToSign", () => {
  it("constructs correct format", async () => {
    const result = await buildStringToSign(
      "POST",
      "/souls/abc/anchors?page=1",
      "1710000000000",
      new TextEncoder().encode('{"q":"hello"}')
    );
    const lines = result.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("POST");
    expect(lines[1]).toBe("/souls/abc/anchors?page=1");
    expect(lines[2]).toBe("1710000000000");
    expect(lines[3].length).toBeGreaterThan(0); // body hash
  });

  it("handles GET with no body", async () => {
    const result = await buildStringToSign(
      "GET",
      "/health",
      "1710000000000",
      undefined
    );
    const lines = result.split("\n");
    expect(lines[0]).toBe("GET");
    expect(lines[3]).toBe(
      await (async () => {
        const { hashBody } = await import("../src/signing.js");
        return hashBody(undefined);
      })()
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/crypto/test/signing.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 signing**

```typescript
// packages/crypto/src/signing.ts
import { base58Encode } from "./base58.js";

export async function hashBody(
  body: Uint8Array | undefined | null
): Promise<string> {
  const data =
    body && body.length > 0 ? body : new Uint8Array(0);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base58Encode(new Uint8Array(hash));
}

export async function buildStringToSign(
  method: string,
  path: string,
  timestamp: string,
  body: Uint8Array | undefined | null
): Promise<string> {
  const bodyHash = await hashBody(body);
  return `${method}\n${path}\n${timestamp}\n${bodyHash}`;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/crypto/test/signing.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: 创建 index.ts 公共导出**

```typescript
// packages/crypto/src/index.ts
export { base58Encode, base58Decode } from "./base58.js";
export { generateKeyPair, getPublicKey, sign, verify } from "./ed25519.js";
export { hashBody, buildStringToSign } from "./signing.js";
```

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat(crypto): add signing protocol (StringToSign + body hash)"
```

## Chunk 2: 服务端 auth 中间件

### Task 5: 签名验证中间件

**Files:**
- Create: `packages/server/src/middleware/auth.ts`
- Create: `packages/server/test/middleware/auth.test.ts`

- [ ] **Step 1: 写失败测试**

测试不依赖 HTTP 框架。中间件接收一个描述请求的对象，返回验证结果。

```typescript
// packages/server/test/middleware/auth.test.ts
import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  getPublicKey,
  sign,
  buildStringToSign,
} from "@remi/crypto";
import { verifyRequest, AuthError } from "../src/middleware/auth.js";

describe("verifyRequest", () => {
  async function makeSignedRequest(opts: {
    timestampOverride?: string;
  } = {}) {
    const privateKey = generateKeyPair();
    const publicKey = getPublicKey(privateKey);
    const method = "POST";
    const path = "/test";
    const timestamp = opts.timestampOverride ?? String(Date.now());
    const body = new TextEncoder().encode('{"q":"hi"}');
    const sts = await buildStringToSign(method, path, timestamp, body);
    const signature = await sign(new TextEncoder().encode(sts), privateKey);
    return { method, path, timestamp, body, publicKey, signature };
  }

  it("accepts valid signature", async () => {
    const req = await makeSignedRequest();
    const result = await verifyRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.publicKey).toBe(req.publicKey);
  });

  it("rejects missing public key", async () => {
    const req = await makeSignedRequest();
    const result = await verifyRequest({ ...req, publicKey: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("MISSING_AUTH_HEADER");
  });

  it("rejects expired timestamp", async () => {
    const old = String(Date.now() - 60_000);
    const req = await makeSignedRequest({ timestampOverride: old });
    const result = await verifyRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("TIMESTAMP_EXPIRED");
  });

  it("rejects invalid signature", async () => {
    const req = await makeSignedRequest();
    const result = await verifyRequest({ ...req, signature: "badSig123" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("INVALID_SIGNATURE");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/server/test/middleware/auth.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 auth 中间件**

```typescript
// packages/server/src/middleware/auth.ts
import { verify, buildStringToSign } from "@remi/crypto";

export type AuthError =
  | "MISSING_AUTH_HEADER"
  | "TIMESTAMP_EXPIRED"
  | "INVALID_SIGNATURE";

type AuthResult =
  | { ok: true; publicKey: string }
  | { ok: false; error: AuthError; message: string };

interface RequestInfo {
  method: string;
  path: string;
  timestamp: string | undefined;
  publicKey: string | undefined;
  signature: string | undefined;
  body: Uint8Array | undefined | null;
}

const MAX_TIMESTAMP_DRIFT_MS = 30_000;

export async function verifyRequest(req: RequestInfo): Promise<AuthResult> {
  if (!req.publicKey || !req.timestamp || !req.signature) {
    return {
      ok: false,
      error: "MISSING_AUTH_HEADER",
      message: "Missing required auth headers",
    };
  }

  const drift = Math.abs(Date.now() - Number(req.timestamp));
  if (drift > MAX_TIMESTAMP_DRIFT_MS) {
    return {
      ok: false,
      error: "TIMESTAMP_EXPIRED",
      message: "Timestamp outside acceptable window",
    };
  }

  const sts = await buildStringToSign(
    req.method, req.path, req.timestamp, req.body
  );
  const valid = await verify(
    new TextEncoder().encode(sts),
    req.signature,
    req.publicKey
  );
  if (!valid) {
    return {
      ok: false,
      error: "INVALID_SIGNATURE",
      message: "Signature verification failed",
    };
  }

  return { ok: true, publicKey: req.publicKey };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/server/test/middleware/auth.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(server): add auth signature verification middleware"
```

### Task 5b: 角色判定

**Files:**
- Create: `packages/server/src/middleware/role.ts`
- Create: `packages/server/test/middleware/role.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/server/test/middleware/role.test.ts
import { describe, it, expect } from "vitest";
import { determineRole, Role } from "../src/middleware/role.js";

describe("determineRole", () => {
  it("returns 'owner' when signer matches target", () => {
    const key = "abc123base58key";
    expect(determineRole(key, key)).toBe("owner");
  });

  it("returns 'visitor' when signer differs from target", () => {
    expect(determineRole("signerKey", "ownerKey")).toBe("visitor");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/server/test/middleware/role.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现角色判定**

```typescript
// packages/server/src/middleware/role.ts
export type Role = "owner" | "visitor";

export function determineRole(
  signerPublicKey: string,
  targetPublicKey: string
): Role {
  return signerPublicKey === targetPublicKey ? "owner" : "visitor";
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/server/test/middleware/role.test.ts`
Expected: 2 tests PASS

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(server): add role determination (owner vs visitor)"
```

## Chunk 3: 客户端 KeyStore

### Task 6: KeyStore 模块

**Files:**
- Create: `packages/client/src/keystore.ts`
- Create: `packages/client/test/keystore.test.ts`

- [ ] **Step 1: 写失败测试**

测试环境无 IndexedDB，KeyStore 应降级为内存模式（ephemeral）。

```typescript
// packages/client/test/keystore.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { KeyStore } from "../src/keystore.js";
import { verify, buildStringToSign } from "@remi/crypto";

describe("KeyStore", () => {
  let ks: KeyStore;

  beforeEach(async () => {
    ks = new KeyStore();
    await ks.init();
  });

  it("initializes and generates key", () => {
    const pub = ks.getPublicKey();
    expect(typeof pub).toBe("string");
    expect(pub.length).toBeGreaterThan(0);
  });

  it("is ephemeral in test environment (no IndexedDB)", () => {
    expect(ks.isEphemeral()).toBe(true);
  });

  it("signs data that can be verified", async () => {
    const message = new TextEncoder().encode("test message");
    const sig = await ks.sign(message);
    const pub = ks.getPublicKey();
    expect(await verify(message, sig, pub)).toBe(true);
  });

  it("exports and imports private key", async () => {
    const original = ks.getPublicKey();
    const exported = ks.exportPrivateKey();

    const ks2 = new KeyStore();
    await ks2.init();
    await ks2.importPrivateKey(exported);
    expect(ks2.getPublicKey()).toBe(original);
  });

  it("rejects invalid private key on import", async () => {
    await expect(ks.importPrivateKey("not-a-valid-key!!!"))
      .rejects.toThrow();
  });

  it("produces valid signature for auth protocol", async () => {
    const method = "GET";
    const path = "/test";
    const timestamp = String(Date.now());
    const sts = await buildStringToSign(method, path, timestamp, undefined);
    const sig = await ks.sign(new TextEncoder().encode(sts));
    const pub = ks.getPublicKey();
    expect(await verify(new TextEncoder().encode(sts), sig, pub)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/client/test/keystore.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 KeyStore**

```typescript
// packages/client/src/keystore.ts
import { generateKeyPair, getPublicKey, sign as edSign } from "@remi/crypto";

const DB_NAME = "remi-keystore";
const STORE_NAME = "keys";
const KEY = "privateKey";

export class KeyStore {
  private privateKey: string | null = null;
  private publicKey: string | null = null;
  private ephemeral = false;

  async init(): Promise<void> {
    const stored = await this.loadFromStorage();
    if (stored) {
      this.privateKey = stored;
    } else {
      this.privateKey = generateKeyPair();
      await this.saveToStorage(this.privateKey);
    }
    this.publicKey = getPublicKey(this.privateKey);
  }

  getPublicKey(): string {
    if (!this.publicKey) throw new Error("KeyStore not initialized");
    return this.publicKey;
  }

  async sign(data: Uint8Array): Promise<string> {
    if (!this.privateKey) throw new Error("KeyStore not initialized");
    return edSign(data, this.privateKey);
  }

  exportPrivateKey(): string {
    if (!this.privateKey) throw new Error("KeyStore not initialized");
    return this.privateKey;
  }

  async importPrivateKey(key: string): Promise<void> {
    // 验证: 尝试推导公钥，无效则抛异常
    const pub = getPublicKey(key);
    this.privateKey = key;
    this.publicKey = pub;
    await this.saveToStorage(key);
  }

  isEphemeral(): boolean {
    return this.ephemeral;
  }

  private async loadFromStorage(): Promise<string | null> {
    if (!this.isIndexedDBAvailable()) {
      this.ephemeral = true;
      return null;
    }
    try {
      const db = await this.openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(KEY);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      this.ephemeral = true;
      return null;
    }
  }

  private async saveToStorage(value: string): Promise<void> {
    if (this.ephemeral) return;
    try {
      const db = await this.openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(value, KEY);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch {
      // storage失败不阻断，降级为ephemeral
      this.ephemeral = true;
    }
  }

  private isIndexedDBAvailable(): boolean {
    try {
      return typeof indexedDB !== "undefined";
    } catch {
      return false;
    }
  }

  private openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/client/test/keystore.test.ts`
Expected: 6 tests PASS

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(client): add KeyStore module with IndexedDB/ephemeral fallback"
```

### Task 7: 端到端集成测试

**Files:**
- Create: `test/integration.test.ts`（仓库根目录）

- [ ] **Step 1: 写集成测试**

验证客户端签名 → 服务端验证的完整流程。

```typescript
// test/integration.test.ts
import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  getPublicKey,
  sign,
  buildStringToSign,
} from "@remi/crypto";
import { verifyRequest } from "@remi/server/middleware/auth";

describe("end-to-end auth flow", () => {
  it("client signs, server verifies", async () => {
    const privateKey = generateKeyPair();
    const publicKey = getPublicKey(privateKey);
    const method = "POST";
    const path = "/s/somePubKey/ask";
    const timestamp = String(Date.now());
    const body = new TextEncoder().encode('{"question":"你好"}');
    const sts = await buildStringToSign(method, path, timestamp, body);
    const signature = await sign(new TextEncoder().encode(sts), privateKey);

    const result = await verifyRequest({
      method, path, timestamp, body,
      publicKey, signature,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.publicKey).toBe(publicKey);
    }
  });

  it("detects tampered body", async () => {
    const privateKey = generateKeyPair();
    const publicKey = getPublicKey(privateKey);
    const method = "POST";
    const path = "/s/somePubKey/ask";
    const timestamp = String(Date.now());
    const body = new TextEncoder().encode('{"question":"你好"}');
    const sts = await buildStringToSign(method, path, timestamp, body);
    const signature = await sign(new TextEncoder().encode(sts), privateKey);

    // 篡改 body
    const tampered = new TextEncoder().encode('{"question":"篡改"}');
    const result = await verifyRequest({
      method, path, timestamp,
      body: tampered,
      publicKey, signature,
    });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认通过**

Run: `npx vitest run test/integration.test.ts`
Expected: 2 tests PASS

- [ ] **Step 3: 运行全部测试**

Run: `npx vitest run`
Expected: 所有测试 PASS（base58: 3, ed25519: 5, signing: 4, auth: 4, role: 2, keystore: 6, integration: 2 = 共 26 tests）

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "test: add end-to-end auth integration test"
```
