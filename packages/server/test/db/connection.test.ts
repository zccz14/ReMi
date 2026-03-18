import { describe, it, expect, afterEach } from "vitest";
import { ConnectionManager } from "../../src/db/connection.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("ConnectionManager", () => {
  const tmpDirs: string[] = [];

  function createTmpDir(): string {
    const dir = path.join(os.tmpdir(), `remi-test-${crypto.randomUUID()}`);
    fs.mkdirSync(dir, { recursive: true });
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // cleanup best-effort
      }
    }
    tmpDirs.length = 0;
  });

  it("should create a new database when create=true", () => {
    const dir = createTmpDir();
    const mgr = new ConnectionManager(dir, { maxSize: 10, embeddingDimensions: 1536 });
    const conn = mgr.getConnection("testkey", { create: true });
    expect(conn).toBeDefined();
    expect(fs.existsSync(path.join(dir, "testkey.sqlite"))).toBe(true);
    mgr.closeAll();
  });

  it("should throw when create=false and db does not exist", () => {
    const dir = createTmpDir();
    const mgr = new ConnectionManager(dir, { maxSize: 10, embeddingDimensions: 1536 });
    expect(() => mgr.getConnection("noexist", { create: false })).toThrow();
    mgr.closeAll();
  });

  it("should return cached connection on second call", () => {
    const dir = createTmpDir();
    const mgr = new ConnectionManager(dir, { maxSize: 10, embeddingDimensions: 1536 });
    const c1 = mgr.getConnection("key1", { create: true });
    const c2 = mgr.getConnection("key1");
    expect(c1).toBe(c2);
    mgr.closeAll();
  });

  it("should evict LRU entry when cache is full", () => {
    const dir = createTmpDir();
    const mgr = new ConnectionManager(dir, { maxSize: 2, embeddingDimensions: 1536 });
    mgr.getConnection("a", { create: true });
    mgr.getConnection("b", { create: true });
    mgr.getConnection("c", { create: true });
    const conn = mgr.getConnection("a");
    expect(conn).toBeDefined();
    mgr.closeAll();
  });

  it("should remove connection from cache", () => {
    const dir = createTmpDir();
    const mgr = new ConnectionManager(dir, { maxSize: 10, embeddingDimensions: 1536 });
    mgr.getConnection("key1", { create: true });
    mgr.removeConnection("key1");
    expect(fs.existsSync(path.join(dir, "key1.sqlite"))).toBe(true);
    mgr.closeAll();
  });

  it("should check if a soul exists", () => {
    const dir = createTmpDir();
    const mgr = new ConnectionManager(dir, { maxSize: 10, embeddingDimensions: 1536 });
    expect(mgr.soulExists("key1")).toBe(false);
    mgr.getConnection("key1", { create: true });
    expect(mgr.soulExists("key1")).toBe(true);
    mgr.closeAll();
  });
});
