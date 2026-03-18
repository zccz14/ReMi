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

  async function signedRequest(
    method: string,
    urlPath: string,
    body?: string
  ) {
    const timestamp = String(Date.now());
    const bodyBytes = body ? new TextEncoder().encode(body) : undefined;
    const sts = await buildStringToSign(method, urlPath, timestamp, bodyBytes);
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
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
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
      JSON.stringify({ question: "最重要的事？", source: "manual" })
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
      JSON.stringify({ answer: "保持好奇心" })
    );
    expect(updateRes.status).toBe(200);
    const { data: updated } = await updateRes.json();
    expect(updated.answer).toBe("保持好奇心");

    // Delete single
    const delRes = await signedRequest(
      "DELETE",
      `/api/${pubKey}/anchors/${anchor.id}`
    );
    expect(delRes.status).toBe(204);
  });

  it("soul copy + delete lifecycle", async () => {
    // Create an anchor to ensure there's data
    await signedRequest(
      "POST",
      `/api/${pubKey}/anchors`,
      JSON.stringify({ question: "Q1", source: "manual" })
    );

    // Copy
    const newPrivKey = generateKeyPair();
    const newPubKey = getPublicKey(newPrivKey);
    const copyRes = await signedRequest(
      "POST",
      `/api/${pubKey}/copy`,
      JSON.stringify({ targetPubKey: newPubKey })
    );
    expect(copyRes.status).toBe(201);

    // Delete old
    const delRes = await signedRequest("DELETE", `/api/${pubKey}`);
    expect(delRes.status).toBe(204);
  });

  it("unauthenticated request returns 401", async () => {
    const res = await app.request(`/api/${pubKey}/anchors`);
    expect(res.status).toBe(401);
  });
});
