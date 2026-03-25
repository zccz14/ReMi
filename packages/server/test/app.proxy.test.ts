import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createApp } from "../src/app.js";

describe("createApp proxy mode", () => {
  let tmpDir: string;
  const env = { ...process.env };

  beforeEach(() => {
    process.env = { ...env };
    tmpDir = path.join(os.tmpdir(), `remi-app-proxy-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it("keeps /api routes owned by Hono in proxy mode", async () => {
    const { app, connMgr } = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      web: {
        mode: "proxy",
        viteOrigin: "http://127.0.0.1:5173",
      },
    });

    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
    connMgr.closeAll();
  });

  it("proxies non-api document requests to Vite", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<html><body>vite ok</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { app, connMgr } = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      web: {
        mode: "proxy",
        viteOrigin: "http://127.0.0.1:5173",
      },
    });

    const res = await app.request("/messages");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:5173/messages",
      expect.objectContaining({ method: "GET" }),
    );
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain("vite ok");
    connMgr.closeAll();
  });

  it("preserves query strings for Vite asset requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("console.log('ok')", {
        status: 200,
        headers: { "Content-Type": "application/javascript" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { app, connMgr } = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      web: {
        mode: "proxy",
        viteOrigin: "http://127.0.0.1:5173",
      },
    });

    const res = await app.request("/src/main.tsx?t=123");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:5173/src/main.tsx?t=123",
      expect.objectContaining({ method: "GET" }),
    );
    expect(res.status).toBe(200);
    connMgr.closeAll();
  });

  it("applies CORS to /api and /ai routes, but not proxied frontend responses", async () => {
    process.env.CORS_ORIGIN = "http://localhost:5173";

    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<html><body>vite ok</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { app, connMgr } = createApp({
      dataDir: tmpDir,
      embeddingDimensions: 4,
      web: {
        mode: "proxy",
        viteOrigin: "http://127.0.0.1:5173",
      },
    });

    const apiRes = await app.request("/api/health", {
      headers: { Origin: "http://localhost:5173" },
    });
    const aiPreflightRes = await app.request("/ai/v1/chat/completions", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Authorization, Content-Type",
      },
    });
    const pageRes = await app.request("/messages", {
      headers: { Origin: "http://localhost:5173" },
    });

    expect(apiRes.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(aiPreflightRes.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(aiPreflightRes.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(pageRes.headers.get("access-control-allow-origin")).toBeNull();
    connMgr.closeAll();
  });
});
