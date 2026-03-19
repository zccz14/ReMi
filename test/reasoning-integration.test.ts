import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "@remi/server/app";
import { generateKeyPair, getPublicKey, sign, buildStringToSign } from "@remi/crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Hono } from "hono";

describe("reasoning integration", () => {
  let tmpDir: string;
  let app: Hono;
  let cleanup: () => void;
  let ownerPrivKey: string;
  let ownerPubKey: string;
  let visitorPrivKey: string;
  let visitorPubKey: string;

  async function signedRequest(
    method: string,
    urlPath: string,
    privKey: string,
    pubKey: string,
    body?: string,
  ) {
    const timestamp = String(Date.now());
    const bodyBytes = body ? new TextEncoder().encode(body) : undefined;
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

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `remi-reasoning-integ-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const result = createApp({ dataDir: tmpDir, embeddingDimensions: 4 });
    app = result.app;
    cleanup = () => result.connMgr.closeAll();

    ownerPrivKey = generateKeyPair();
    ownerPubKey = getPublicKey(ownerPrivKey);
    visitorPrivKey = generateKeyPair();
    visitorPubKey = getPublicKey(visitorPrivKey);

    // Create owner's soul by making an owner request
    await signedRequest("GET", `/api/${ownerPubKey}/health`, ownerPrivKey, ownerPubKey);
  });

  afterEach(() => {
    cleanup();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("GET /reasoning/messages should return empty initially", async () => {
    const res = await signedRequest(
      "GET",
      `/api/${ownerPubKey}/reasoning/messages`,
      visitorPrivKey,
      visitorPubKey,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toEqual([]);
    expect(body.data.hasMore).toBe(false);
  });

  it("POST /reasoning/message without LLM config should return 500", async () => {
    const res = await signedRequest(
      "POST",
      `/api/${ownerPubKey}/reasoning/message`,
      visitorPrivKey,
      visitorPubKey,
      JSON.stringify({ content: "你好" }),
    );
    expect(res.status).toBe(500);
  });

  it("unauthenticated request should return 401", async () => {
    const res = await app.request(`/api/${ownerPubKey}/reasoning/messages`);
    expect(res.status).toBe(401);
  });
});
