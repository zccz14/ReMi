import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../../src/middleware/hono-auth.js";
import { generateKeyPair, getPublicKey, sign } from "@remi/crypto";
import { buildStringToSign } from "@remi/crypto";

describe("hono-auth middleware", () => {
  function createApp() {
    const app = new Hono();
    app.use("/api/*", authMiddleware());
    app.get("/api/test", (c) => {
      return c.json({ pubKey: c.get("signerPubKey") });
    });
    return app;
  }

  async function signedRequest(
    app: Hono,
    method: string,
    path: string,
    body?: string
  ) {
    const privKey = generateKeyPair();
    const pubKey = getPublicKey(privKey);
    const timestamp = String(Date.now());
    const bodyBytes = body ? new TextEncoder().encode(body) : undefined;
    const sts = await buildStringToSign(method, path, timestamp, bodyBytes);
    const signature = await sign(new TextEncoder().encode(sts), privKey);

    const headers: Record<string, string> = {
      "X-Public-Key": pubKey,
      "X-Timestamp": timestamp,
      "X-Signature": signature,
    };
    if (body) headers["Content-Type"] = "application/json";

    return app.request(path, {
      method,
      headers,
      body: body ?? undefined,
    });
  }

  it("should pass with valid signature and set signerPubKey", async () => {
    const app = createApp();
    const res = await signedRequest(app, "GET", "/api/test");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pubKey).toBeTruthy();
  });

  it("should reject missing auth headers with 401", async () => {
    const app = createApp();
    const res = await app.request("/api/test");
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("MISSING_AUTH_HEADER");
  });

  it("should reject invalid signature with 401", async () => {
    const app = createApp();
    const res = await app.request("/api/test", {
      headers: {
        "X-Public-Key": "fakePubKey",
        "X-Timestamp": String(Date.now()),
        "X-Signature": "fakeSignature",
      },
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("INVALID_SIGNATURE");
  });
});
