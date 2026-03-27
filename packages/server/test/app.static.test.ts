import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createApp } from "../src/app.js";

describe("createApp static mode", () => {
  let tmpDir: string;
  let distDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `remi-app-static-${crypto.randomUUID()}`);
    distDir = path.join(tmpDir, "dist");
    fs.mkdirSync(path.join(distDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(distDir, "index.html"), "<html><body>static ok</body></html>");
    fs.writeFileSync(path.join(distDir, "assets", "app.js"), "console.log('static ok');");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it("serves index.html for root requests in static mode", async () => {
    const { app, connMgr } = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      web: {
        mode: "static",
        distDir,
      },
    });

    const res = await app.request("/", {
      headers: { Accept: "text/html" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    await expect(res.text()).resolves.toContain("static ok");
    connMgr.closeAll();
  });

  it("serves index.html for HTML navigation requests without an extension", async () => {
    const { app, connMgr } = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      web: {
        mode: "static",
        distDir,
      },
    });

    const res = await app.request("/messages", {
      headers: { Accept: "text/html" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    await expect(res.text()).resolves.toContain("static ok");
    connMgr.closeAll();
  });

  it("serves real static assets when they exist", async () => {
    const { app, connMgr } = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      web: {
        mode: "static",
        distDir,
      },
    });

    const res = await app.request("/assets/app.js");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    await expect(res.text()).resolves.toContain("static ok");
    connMgr.closeAll();
  });

  it("returns 404 for missing assets with an extension", async () => {
    const { app, connMgr } = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      web: {
        mode: "static",
        distDir,
      },
    });

    const res = await app.request("/assets/missing.js");

    expect(res.status).toBe(404);
    connMgr.closeAll();
  });

  it("keeps /api routes owned by Hono in static mode", async () => {
    const { app, connMgr } = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      web: {
        mode: "static",
        distDir,
      },
    });

    const res = await app.request("/api/health", {
      headers: { Accept: "text/html" },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
    connMgr.closeAll();
  });

  it("does not let /ai requests fall through to index.html", async () => {
    const { app, connMgr } = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      web: {
        mode: "static",
        distDir,
      },
    });

    const res = await app.request("/ai/unknown", {
      headers: { Accept: "text/html" },
    });

    expect(res.status).toBe(404);
    await expect(res.text()).resolves.not.toContain("static ok");
    connMgr.closeAll();
  });

  it("rejects traversal-like paths outside the dist dir", async () => {
    fs.writeFileSync(path.join(tmpDir, "secret.txt"), "should stay private");

    const { app, connMgr } = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      web: {
        mode: "static",
        distDir,
      },
    });

    const res = await app.request("/..%2Fsecret.txt");

    expect(res.status).toBe(404);
    await expect(res.text()).resolves.not.toContain("should stay private");
    connMgr.closeAll();
  });

  it("fails startup when the static dist directory is invalid", () => {
    expect(() =>
      createApp({
        dataDir: tmpDir,
        embeddingDimensions: 4,
        web: {
          mode: "static",
          distDir: path.join(tmpDir, "missing-dist"),
        },
      }),
    ).toThrow(/dist|index\.html/i);
  });

  it("fails startup when index.html is missing", () => {
    fs.rmSync(path.join(distDir, "index.html"));

    expect(() =>
      createApp({
        dataDir: tmpDir,
        embeddingDimensions: 4,
        web: {
          mode: "static",
          distDir,
        },
      }),
    ).toThrow(/index\.html/i);
  });
});
