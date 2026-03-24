import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import type { Hono } from "hono";
import sharp from "sharp";
import { base58Encode, buildStringToSign, generateKeyPair, getPublicKey, sign } from "@remi/crypto";
import { createApp } from "../../src/app.js";
import { initializeDatabase } from "../../src/db/migrate.js";
import { readRequestBodyBuffer } from "../../src/middleware/hono-auth.js";

const WEBP_BYTES = new Uint8Array(
  Buffer.from(
    "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=",
    "base64",
  ),
);
const FAKE_WEBP_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const TRUNCATED_WEBP_BYTES = WEBP_BYTES.slice(0, 20);
const VP8X_ONLY_WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58,
  0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
const STRUCTURALLY_VALID_BUT_UNDECODABLE_WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
  0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00,
]);
const ANIMATED_WEBP_BYTES = new Uint8Array(
  Buffer.from(
    "UklGRsYAAABXRUJQVlA4WAoAAAACAAAAAAAAAAAAQU5JTQYAAAD/////AABBTk1GSAAAAAAAAAAAAAAAAAAAAGQAAAJWUDggMAAAANABAJ0BKgEAAQABQCYloAJ0ugH4AAOwAP7y63/82BXNc+/3/9Lg/S4P0uD/0pAAAEFOTUZKAAAAAAAAAAAAAAAAAAAAZAAAAFZQOCAyAAAA1AEAnQEqAQABAAAAJiWgAnS6AfgAA7AA/ukiH/vPn7nz9z5/0Z//lP3yOP5HH/ygQAA=",
    "base64",
  ),
);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

describe("profile routes", () => {
  let tmpDir: string;
  let app: Hono;
  let cleanup: () => void;
  let ownerPrivKey: string;
  let ownerPubKey: string;
  let visitorPrivKey: string;
  let visitorPubKey: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `remi-profile-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const created = createApp({ dataDir: tmpDir, embeddingDimensions: 4 });
    app = created.app;
    cleanup = () => created.connMgr.closeAll();

    ownerPrivKey = generateKeyPair();
    ownerPubKey = getPublicKey(ownerPrivKey);
    visitorPrivKey = generateKeyPair();
    visitorPubKey = getPublicKey(visitorPrivKey);
  });

  afterEach(() => {
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function signedRequest(options: {
    signerPrivKey: string;
    signerPubKey: string;
    method: string;
    urlPath: string;
    bodyBytes?: Uint8Array;
    contentType?: string;
  }) {
    const timestamp = String(Date.now());
    const sts = await buildStringToSign(
      options.method,
      new URL(`http://localhost${options.urlPath}`).pathname,
      timestamp,
      options.bodyBytes,
    );
    const signature = await sign(new TextEncoder().encode(sts), options.signerPrivKey);

    const headers: Record<string, string> = {
      "X-Public-Key": options.signerPubKey,
      "X-Timestamp": timestamp,
      "X-Signature": signature,
    };

    if (options.contentType) {
      headers["Content-Type"] = options.contentType;
    }

    return app.request(options.urlPath, {
      method: options.method,
      headers,
      body: options.bodyBytes ? Buffer.from(options.bodyBytes) : undefined,
    });
  }

  async function signedJsonRequest(
    signerPrivKey: string,
    signerPubKey: string,
    method: string,
    urlPath: string,
    body: unknown,
  ) {
    const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
    return signedRequest({
      signerPrivKey,
      signerPubKey,
      method,
      urlPath,
      bodyBytes,
      contentType: "application/json",
    });
  }

  async function readProfileDb(pubKey: string) {
    const db = new Database(path.join(tmpDir, `${pubKey}.sqlite`));
    const profile = db
      .prepare(
        "SELECT display_name AS displayName, bio, updated_at AS updatedAt FROM public_profile",
      )
      .get() as { displayName: string | null; bio: string | null; updatedAt: number } | undefined;
    const avatar = db
      .prepare("SELECT blob, updated_at AS updatedAt FROM public_profile_avatar")
      .get() as { blob: Buffer; updatedAt: number } | undefined;
    db.close();

    return {
      displayName: profile?.displayName ?? "",
      bio: profile?.bio ?? "",
      hasAvatar: Boolean(avatar),
      avatarVersion: avatar?.updatedAt ?? null,
      updatedAt: profile?.updatedAt ?? null,
    };
  }

  async function makeLargeDimensionWebp(width: number, height: number) {
    return new Uint8Array(
      await sharp({
        create: {
          width,
          height,
          channels: 4,
          background: { r: 255, g: 0, b: 0, alpha: 1 },
        },
      })
        .webp()
        .toBuffer(),
    );
  }

  function chunkedStream(bytes: Uint8Array, chunkSize: number) {
    let offset = 0;

    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }

        const end = Math.min(offset + chunkSize, bytes.length);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    });
  }

  it("initializeDatabase bootstraps public profile tables idempotently", () => {
    const db = new Database(":memory:");

    initializeDatabase(db, 4);
    initializeDatabase(db, 4);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('public_profile', 'public_profile_avatar') ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    expect(tables).toEqual([{ name: "public_profile" }, { name: "public_profile_avatar" }]);
    db.close();
  });

  it("readRequestBodyBuffer aborts once body exceeds the configured cap", async () => {
    const request = new Request("http://localhost/upload", {
      method: "PUT",
      body: chunkedStream(new Uint8Array(MAX_AVATAR_BYTES + 1), 256 * 1024),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readRequestBodyBuffer(request, MAX_AVATAR_BYTES)).rejects.toThrow(
      "BODY_TOO_LARGE",
    );
  });

  it("GET /api/:pubKey/profile returns editable empty state for a new owner", async () => {
    const res = await signedRequest({
      signerPrivKey: ownerPrivKey,
      signerPubKey: ownerPubKey,
      method: "GET",
      urlPath: `/api/${ownerPubKey}/profile`,
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: {
        displayName: "",
        bio: "",
        hasAvatar: false,
        avatarVersion: null,
        updatedAt: null,
      },
    });
  });

  it("GET /api/public/:pubKey/profile returns 404 for missing soul", async () => {
    const res = await app.request(`/api/public/${ownerPubKey}/profile`);
    expect(res.status).toBe(404);
  });

  it("GET /api/public/:pubKey/profile is accessible without auth headers for an existing soul", async () => {
    await signedRequest({
      signerPrivKey: ownerPrivKey,
      signerPubKey: ownerPubKey,
      method: "GET",
      urlPath: `/api/${ownerPubKey}/profile`,
    });

    const res = await app.request(`/api/public/${ownerPubKey}/profile`);
    expect(res.status).toBe(200);
  });

  it("GET /api/public/:pubKey/profile/avatar returns 404 when avatar missing", async () => {
    await signedRequest({
      signerPrivKey: ownerPrivKey,
      signerPubKey: ownerPubKey,
      method: "GET",
      urlPath: `/api/${ownerPubKey}/profile`,
    });

    const res = await app.request(`/api/public/${ownerPubKey}/profile/avatar`);
    expect(res.status).toBe(404);
  });

  it("GET /api/public/:pubKey/profile/avatar returns 404 when soul is missing", async () => {
    const res = await app.request(`/api/public/${ownerPubKey}/profile/avatar`);
    expect(res.status).toBe(404);
  });

  it("GET /api/public/:pubKey/profile/avatar returns 200 with image/webp and no auth headers when avatar exists", async () => {
    await signedRequest({
      signerPrivKey: ownerPrivKey,
      signerPubKey: ownerPubKey,
      method: "PUT",
      urlPath: `/api/${ownerPubKey}/profile/avatar`,
      bodyBytes: WEBP_BYTES,
      contentType: "image/webp",
    });

    const res = await app.request(`/api/public/${ownerPubKey}/profile/avatar`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(WEBP_BYTES);
  });

  it("public profile/avatar routes reject invalid pubKey with 422", async () => {
    const profileRes = await app.request("/api/public/not-base58/profile");
    const avatarRes = await app.request("/api/public/not-base58/profile/avatar");

    expect(profileRes.status).toBe(422);
    expect(avatarRes.status).toBe(422);
  });

  it("public profile/avatar routes reject base58 pubKey values with the wrong decoded length", async () => {
    const wrongLengthPubKey = base58Encode(new Uint8Array(31).fill(7));

    const profileRes = await app.request(`/api/public/${wrongLengthPubKey}/profile`);
    const avatarRes = await app.request(`/api/public/${wrongLengthPubKey}/profile/avatar`);

    expect(profileRes.status).toBe(422);
    expect(avatarRes.status).toBe(422);
  });

  it("PUT /api/:pubKey/profile trims displayName and persists bio", async () => {
    const res = await signedJsonRequest(
      ownerPrivKey,
      ownerPubKey,
      "PUT",
      `/api/${ownerPubKey}/profile`,
      {
        displayName: "  Z  ",
        bio: "hello",
      },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: {
        displayName: "Z",
        bio: "hello",
        hasAvatar: false,
        avatarVersion: null,
      },
    });
  });

  it("PUT /api/:pubKey/profile rejects invalid text payloads with 422", async () => {
    const res = await signedJsonRequest(
      ownerPrivKey,
      ownerPubKey,
      "PUT",
      `/api/${ownerPubKey}/profile`,
      {
        displayName: "x".repeat(41),
        bio: "",
      },
    );

    expect(res.status).toBe(422);
  });

  it("visitor cannot update owner profile", async () => {
    await signedRequest({
      signerPrivKey: ownerPrivKey,
      signerPubKey: ownerPubKey,
      method: "GET",
      urlPath: `/api/${ownerPubKey}/profile`,
    });

    const res = await signedJsonRequest(
      visitorPrivKey,
      visitorPubKey,
      "PUT",
      `/api/${ownerPubKey}/profile`,
      {
        displayName: "Z",
        bio: "hello",
      },
    );

    expect(res.status).toBe(403);
  });

  it("PUT /api/:pubKey/profile/avatar stores image/webp and exposes avatarVersion", async () => {
    const res = await signedRequest({
      signerPrivKey: ownerPrivKey,
      signerPubKey: ownerPubKey,
      method: "PUT",
      urlPath: `/api/${ownerPubKey}/profile/avatar`,
      bodyBytes: WEBP_BYTES,
      contentType: "image/webp",
    });

    expect(res.status).toBe(204);
    await expect(readProfileDb(ownerPubKey)).resolves.toMatchObject({
      hasAvatar: true,
      avatarVersion: expect.any(Number),
    });
  });

  it("PUT /api/:pubKey/profile/avatar rejects non-webp uploads with 422", async () => {
    const res = await signedRequest({
      signerPrivKey: ownerPrivKey,
      signerPubKey: ownerPubKey,
      method: "PUT",
      urlPath: `/api/${ownerPubKey}/profile/avatar`,
      bodyBytes: PNG_BYTES,
      contentType: "image/png",
    });

    expect(res.status).toBe(422);
  });

  it("PUT /api/:pubKey/profile/avatar rejects empty webp payloads with 422", async () => {
    const res = await signedRequest({
      signerPrivKey: ownerPrivKey,
      signerPubKey: ownerPubKey,
      method: "PUT",
      urlPath: `/api/${ownerPubKey}/profile/avatar`,
      bodyBytes: new Uint8Array(0),
      contentType: "image/webp",
    });

    expect(res.status).toBe(422);
  });

  it("PUT /api/:pubKey/profile/avatar rejects malformed webp payloads with 422", async () => {
    const res = await signedRequest({
      signerPrivKey: ownerPrivKey,
      signerPubKey: ownerPubKey,
      method: "PUT",
      urlPath: `/api/${ownerPubKey}/profile/avatar`,
      bodyBytes: FAKE_WEBP_BYTES,
      contentType: "image/webp",
    });

    expect(res.status).toBe(422);
  });

  it("PUT /api/:pubKey/profile/avatar rejects truncated webp payloads with 422", async () => {
    const res = await signedRequest({
      signerPrivKey: ownerPrivKey,
      signerPubKey: ownerPubKey,
      method: "PUT",
      urlPath: `/api/${ownerPubKey}/profile/avatar`,
      bodyBytes: TRUNCATED_WEBP_BYTES,
      contentType: "image/webp",
    });

    expect(res.status).toBe(422);
  });

  it("PUT /api/:pubKey/profile/avatar rejects VP8X-only metadata payloads with 422", async () => {
    const res = await signedRequest({
      signerPrivKey: ownerPrivKey,
      signerPubKey: ownerPubKey,
      method: "PUT",
      urlPath: `/api/${ownerPubKey}/profile/avatar`,
      bodyBytes: VP8X_ONLY_WEBP_BYTES,
      contentType: "image/webp",
    });

    expect(res.status).toBe(422);
  });

  it("PUT /api/:pubKey/profile/avatar rejects structurally plausible but undecodable webp payloads with 422", async () => {
    const res = await signedRequest({
      signerPrivKey: ownerPrivKey,
      signerPubKey: ownerPubKey,
      method: "PUT",
      urlPath: `/api/${ownerPubKey}/profile/avatar`,
      bodyBytes: STRUCTURALLY_VALID_BUT_UNDECODABLE_WEBP_BYTES,
      contentType: "image/webp",
    });

    expect(res.status).toBe(422);
  });

  it("PUT /api/:pubKey/profile/avatar rejects animated webp payloads with 422", async () => {
    const res = await signedRequest({
      signerPrivKey: ownerPrivKey,
      signerPubKey: ownerPubKey,
      method: "PUT",
      urlPath: `/api/${ownerPubKey}/profile/avatar`,
      bodyBytes: ANIMATED_WEBP_BYTES,
      contentType: "image/webp",
    });

    expect(res.status).toBe(422);
  });

  it("PUT /api/:pubKey/profile/avatar rejects overly large image dimensions with 422", async () => {
    const res = await signedRequest({
      signerPrivKey: ownerPrivKey,
      signerPubKey: ownerPubKey,
      method: "PUT",
      urlPath: `/api/${ownerPubKey}/profile/avatar`,
      bodyBytes: await makeLargeDimensionWebp(4096, 1),
      contentType: "image/webp",
    });

    expect(res.status).toBe(422);
  });

  it("PUT /api/:pubKey/profile/avatar rejects oversized uploads with 422", async () => {
    const res = await signedRequest({
      signerPrivKey: ownerPrivKey,
      signerPubKey: ownerPubKey,
      method: "PUT",
      urlPath: `/api/${ownerPubKey}/profile/avatar`,
      bodyBytes: new Uint8Array(MAX_AVATAR_BYTES + 1),
      contentType: "image/webp",
    });

    expect(res.status).toBe(422);
  });

  it("visitor cannot upload or delete owner avatar", async () => {
    await signedRequest({
      signerPrivKey: ownerPrivKey,
      signerPubKey: ownerPubKey,
      method: "GET",
      urlPath: `/api/${ownerPubKey}/profile`,
    });

    const uploadRes = await signedRequest({
      signerPrivKey: visitorPrivKey,
      signerPubKey: visitorPubKey,
      method: "PUT",
      urlPath: `/api/${ownerPubKey}/profile/avatar`,
      bodyBytes: WEBP_BYTES,
      contentType: "image/webp",
    });
    const deleteRes = await signedRequest({
      signerPrivKey: visitorPrivKey,
      signerPubKey: visitorPubKey,
      method: "DELETE",
      urlPath: `/api/${ownerPubKey}/profile/avatar`,
    });

    expect(uploadRes.status).toBe(403);
    expect(deleteRes.status).toBe(403);
  });

  it("DELETE /api/:pubKey/profile/avatar removes the avatar row", async () => {
    await signedRequest({
      signerPrivKey: ownerPrivKey,
      signerPubKey: ownerPubKey,
      method: "PUT",
      urlPath: `/api/${ownerPubKey}/profile/avatar`,
      bodyBytes: WEBP_BYTES,
      contentType: "image/webp",
    });

    const res = await signedRequest({
      signerPrivKey: ownerPrivKey,
      signerPubKey: ownerPubKey,
      method: "DELETE",
      urlPath: `/api/${ownerPubKey}/profile/avatar`,
    });

    expect(res.status).toBe(204);
    await expect(readProfileDb(ownerPubKey)).resolves.toMatchObject({
      hasAvatar: false,
      avatarVersion: null,
    });
  });

  it("signed avatar upload succeeds through auth middleware with raw body-byte signing", async () => {
    const res = await signedRequest({
      signerPrivKey: ownerPrivKey,
      signerPubKey: ownerPubKey,
      method: "PUT",
      urlPath: `/api/${ownerPubKey}/profile/avatar?cacheBust=1`,
      bodyBytes: WEBP_BYTES,
      contentType: "image/webp",
    });

    expect(res.status).toBe(204);
  });
});
