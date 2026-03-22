import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initializeDatabase } from "../../src/db/migrate.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("initializeDatabase", () => {
  const tmpFiles: string[] = [];

  function createTmpDb(): string {
    const p = path.join(os.tmpdir(), `remi-test-${crypto.randomUUID()}.sqlite`);
    tmpFiles.push(p);
    return p;
  }

  afterEach(() => {
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        // cleanup best-effort
      }
    }
    tmpFiles.length = 0;
  });

  it("should create soul_anchors and memories tables", () => {
    const dbPath = createTmpDb();
    const db = new Database(dbPath);
    initializeDatabase(db, 1536);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("soul_anchors");
    expect(names).toContain("memories");
    db.close();
  });

  it("should load sqlite-vec and create vector tables", () => {
    const dbPath = createTmpDb();
    const db = new Database(dbPath);
    initializeDatabase(db, 1536);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("soul_anchors_vec");
    expect(names).toContain("memories_vec");
    db.close();
  });

  it("should create messages table", () => {
    const dbPath = createTmpDb();
    const db = new Database(dbPath);
    initializeDatabase(db, 1536);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("messages");
    const info = db.prepare("PRAGMA table_info(messages)").all() as {
      name: string;
    }[];
    const columns = info.map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["id", "role", "content", "created_at"]));
    db.close();
  });

  it("should create reasoning_messages table", () => {
    const dbPath = createTmpDb();
    const db = new Database(dbPath);
    initializeDatabase(db, 1536);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("reasoning_messages");
    const info = db.prepare("PRAGMA table_info(reasoning_messages)").all();
    const columns = (info as { name: string }[]).map((c) => c.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "id",
        "visitor_key",
        "role",
        "content",
        "recalled_anchors",
        "anchor_selection_strategy",
        "created_at",
      ]),
    );
    db.close();
  });

  it("should be idempotent (safe to call twice)", () => {
    const dbPath = createTmpDb();
    const db = new Database(dbPath);
    initializeDatabase(db, 1536);
    initializeDatabase(db, 1536);
    db.close();
  });
});
