import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "@remi/server/app";
import { generateKeyPair, getPublicKey, sign, buildStringToSign } from "@remi/crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Hono } from "hono";

describe("interview integration", () => {
  let tmpDir: string;
  let app: Hono;
  let cleanup: () => void;
  let privKey: string;
  let pubKey: string;

  async function signedRequest(method: string, urlPath: string, body?: string) {
    const timestamp = String(Date.now());
    const bodyBytes = body ? new TextEncoder().encode(body) : undefined;
    // Auth middleware signs only the pathname (no query string)
    const pathname = urlPath.split("?")[0];
    const sts = await buildStringToSign(method, pathname, timestamp, bodyBytes);
    const signature = await sign(new TextEncoder().encode(sts), privKey);

    const headers: Record<string, string> = {
      "X-Public-Key": pubKey,
      "X-Timestamp": timestamp,
      "X-Signature": signature,
    };
    if (body) headers["Content-Type"] = "application/json";

    return app.request(urlPath, { method, headers, body: body ?? undefined });
  }

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `remi-integ-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const result = createApp({ dataDir: tmpDir, embeddingDimensions: 4 });
    app = result.app;
    cleanup = () => result.connMgr.closeAll();
    privKey = generateKeyPair();
    pubKey = getPublicKey(privKey);
  });

  afterEach(() => {
    cleanup();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("GET /interview/status should return initial stats", async () => {
    const res = await signedRequest("GET", `/api/${pubKey}/interview/status`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.totalAnchors).toBe(0);
    expect(json.data.totalMessages).toBe(0);
    expect(json.data.lastActiveAt).toBeNull();
  });

  it("GET /interview/messages should return empty initially", async () => {
    const res = await signedRequest("GET", `/api/${pubKey}/interview/messages?limit=20`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.items).toEqual([]);
    expect(json.data.hasMore).toBe(false);
  });

  it("unauthenticated request should return 401", async () => {
    const res = await app.request(`/api/${pubKey}/interview/status`);
    expect(res.status).toBe(401);
  });
});
