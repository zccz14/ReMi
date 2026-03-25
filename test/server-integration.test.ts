import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "@remi/server/app";
import { generateKeyPair, getPublicKey, sign, buildStringToSign } from "@remi/crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Hono } from "hono";

describe("server integration", () => {
  let tmpDir: string;
  let app: Hono;
  let cleanup: () => void;
  let privKey: string;
  let pubKey: string;
  let visitorPrivKey: string;
  let visitorPubKey: string;

  async function signedRequestWithKey(
    signerPrivKey: string,
    signerPubKey: string,
    method: string,
    urlPath: string,
    body?: string,
  ) {
    const timestamp = String(Date.now());
    const bodyBytes = body ? new TextEncoder().encode(body) : undefined;
    const sts = await buildStringToSign(method, urlPath, timestamp, bodyBytes);
    const signature = await sign(new TextEncoder().encode(sts), signerPrivKey);

    const headers: Record<string, string> = {
      "X-Public-Key": signerPubKey,
      "X-Timestamp": timestamp,
      "X-Signature": signature,
    };
    if (body) headers["Content-Type"] = "application/json";

    return app.request(urlPath, { method, headers, body: body ?? undefined });
  }

  async function signedRequest(method: string, urlPath: string, body?: string) {
    return signedRequestWithKey(privKey, pubKey, method, urlPath, body);
  }

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `remi-integ-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const result = createApp({ dataDir: tmpDir, embeddingDimensions: 4 });
    app = result.app;
    cleanup = () => result.connMgr.closeAll();
    privKey = generateKeyPair();
    pubKey = getPublicKey(privKey);
    visitorPrivKey = generateKeyPair();
    visitorPubKey = getPublicKey(visitorPrivKey);
  });

  afterEach(() => {
    cleanup();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("health check works without auth", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
  });

  it("full anchor CRUD lifecycle", async () => {
    // Create
    const createRes = await signedRequest(
      "POST",
      `/api/${pubKey}/anchors`,
      JSON.stringify({ question: "最重要的事？", source: "manual" }),
    );
    expect(createRes.status).toBe(201);
    const { data: anchor } = await createRes.json();

    // List
    const listRes = await signedRequest("GET", `/api/${pubKey}/anchors`);
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    expect(listJson.data.total).toBe(1);

    // Update
    const updateRes = await signedRequest(
      "PUT",
      `/api/${pubKey}/anchors/${anchor.id}`,
      JSON.stringify({ answer: "保持好奇心" }),
    );
    expect(updateRes.status).toBe(200);
    const { data: updated } = await updateRes.json();
    expect(updated.answer).toBe("保持好奇心");

    // Delete single
    const delRes = await signedRequest("DELETE", `/api/${pubKey}/anchors/${anchor.id}`);
    expect(delRes.status).toBe(204);
  });

  it("soul copy + delete lifecycle", async () => {
    // Create an anchor to ensure there's data
    await signedRequest(
      "POST",
      `/api/${pubKey}/anchors`,
      JSON.stringify({ question: "Q1", source: "manual" }),
    );

    // Copy
    const newPrivKey = generateKeyPair();
    const newPubKey = getPublicKey(newPrivKey);
    const copyRes = await signedRequest(
      "POST",
      `/api/${pubKey}/copy`,
      JSON.stringify({ targetPubKey: newPubKey }),
    );
    expect(copyRes.status).toBe(201);

    // Delete old
    const delRes = await signedRequest("DELETE", `/api/${pubKey}`);
    expect(delRes.status).toBe(204);
  });

  it("owner api token create list delete lifecycle", async () => {
    const createRes = await signedRequest(
      "POST",
      `/api/${pubKey}/api-tokens`,
      JSON.stringify({ note: "Cursor local" }),
    );
    expect(createRes.status).toBe(201);
    const createJson = await createRes.json();
    expect(createJson).toMatchObject({
      id: expect.stringMatching(/^sk-/),
      note: "Cursor local",
      createdAt: expect.any(String),
    });

    const listRes = await signedRequest("GET", `/api/${pubKey}/api-tokens`);
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    expect(listJson.items).toHaveLength(1);
    expect(listJson.items[0]).toMatchObject({
      id: createJson.id,
      tokenPrefix: `${createJson.id.slice(0, 6)}...`,
      note: "Cursor local",
      createdAt: createJson.createdAt,
    });

    const deleteRes = await signedRequest("DELETE", `/api/${pubKey}/api-tokens/${createJson.id}`);
    expect(deleteRes.status).toBe(204);

    const listAfterDeleteRes = await signedRequest("GET", `/api/${pubKey}/api-tokens`);
    expect(listAfterDeleteRes.status).toBe(200);
    const listAfterDeleteJson = await listAfterDeleteRes.json();
    expect(listAfterDeleteJson.items).toHaveLength(0);
  });

  it("signed visitor is forbidden from api token create before validation", async () => {
    const seedRes = await signedRequest(
      "POST",
      `/api/${pubKey}/api-tokens`,
      JSON.stringify({ note: "Seed token" }),
    );
    expect(seedRes.status).toBe(201);

    const res = await signedRequestWithKey(
      visitorPrivKey,
      visitorPubKey,
      "POST",
      `/api/${pubKey}/api-tokens`,
      JSON.stringify({}),
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "FORBIDDEN",
      message: "Owner access required",
    });
  });

  it("signed visitor is forbidden from api token list and delete", async () => {
    const createRes = await signedRequest(
      "POST",
      `/api/${pubKey}/api-tokens`,
      JSON.stringify({ note: "Owner token" }),
    );
    expect(createRes.status).toBe(201);
    const createJson = await createRes.json();

    const listRes = await signedRequestWithKey(
      visitorPrivKey,
      visitorPubKey,
      "GET",
      `/api/${pubKey}/api-tokens`,
    );
    expect(listRes.status).toBe(403);
    await expect(listRes.json()).resolves.toEqual({
      error: "FORBIDDEN",
      message: "Owner access required",
    });

    const deleteRes = await signedRequestWithKey(
      visitorPrivKey,
      visitorPubKey,
      "DELETE",
      `/api/${pubKey}/api-tokens/${createJson.id}`,
    );
    expect(deleteRes.status).toBe(403);
    await expect(deleteRes.json()).resolves.toEqual({
      error: "FORBIDDEN",
      message: "Owner access required",
    });
  });

  it("unauthenticated request returns 401", async () => {
    const res = await app.request(`/api/${pubKey}/anchors`);
    expect(res.status).toBe(401);
  });
});
