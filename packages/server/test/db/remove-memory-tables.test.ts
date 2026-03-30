import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeMemoryTables, runRemoveMemoryTablesCli } from "../../src/db/remove-memory-tables.js";

describe("removeMemoryTables", () => {
  const tmpPaths: string[] = [];

  function createTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remi-memory-removal-"));
    tmpPaths.push(dir);
    return dir;
  }

  function createLegacyDb(
    filePath: string,
    options?: { memories?: boolean; memoriesVec?: boolean },
  ): void {
    const db = new Database(filePath);
    sqliteVec.load(db);

    if (options?.memories ?? true) {
      db.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          occurred_at INTEGER NOT NULL,
          source TEXT NOT NULL,
          metadata TEXT,
          created_at INTEGER NOT NULL
        );
      `);
    }

    if (options?.memoriesVec ?? true) {
      db.exec(`
        CREATE VIRTUAL TABLE memories_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding FLOAT[4]
        );
      `);
    }

    db.close();
  }

  function listTables(filePath: string): string[] {
    const db = new Database(filePath);
    const names = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table') ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    db.close();
    return names;
  }

  afterEach(() => {
    for (const tmpPath of tmpPaths) {
      try {
        fs.rmSync(tmpPath, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpPaths.length = 0;
  });

  it("fails for a missing --db argument", () => {
    const errors: string[] = [];

    const exitCode = runRemoveMemoryTablesCli([], {
      info: () => {},
      error: (message) => errors.push(message),
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("Missing required --db");
  });

  it("fails for a nonexistent absolute path and creates no file", () => {
    const dir = createTmpDir();
    const dbPath = path.join(dir, "missing.sqlite");
    const errors: string[] = [];

    const exitCode = runRemoveMemoryTablesCli(["--db", dbPath], {
      info: () => {},
      error: (message) => errors.push(message),
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("does not exist");
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("fails for a relative path", () => {
    const errors: string[] = [];

    const exitCode = runRemoveMemoryTablesCli(["--db", "relative.sqlite"], {
      info: () => {},
      error: (message) => errors.push(message),
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("must be absolute");
  });

  it("fails for a directory path", () => {
    const dir = createTmpDir();
    const errors: string[] = [];

    const exitCode = runRemoveMemoryTablesCli(["--db", dir], {
      info: () => {},
      error: (message) => errors.push(message),
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("must point to a file");
  });

  it("drops both memories and memories_vec tables", () => {
    const dir = createTmpDir();
    const dbPath = path.join(dir, "legacy.sqlite");
    createLegacyDb(dbPath);

    const result = removeMemoryTables(dbPath);

    expect(result.droppedTables).toEqual(["memories_vec", "memories"]);
    expect(listTables(dbPath)).not.toContain("memories");
    expect(listTables(dbPath)).not.toContain("memories_vec");
  });

  it("succeeds when only one legacy table exists", () => {
    const dir = createTmpDir();
    const dbPath = path.join(dir, "legacy.sqlite");
    createLegacyDb(dbPath, { memories: true, memoriesVec: false });

    removeMemoryTables(dbPath);

    expect(listTables(dbPath)).not.toContain("memories");
    expect(listTables(dbPath)).not.toContain("memories_vec");
  });

  it("is idempotent when run repeatedly", () => {
    const dir = createTmpDir();
    const dbPath = path.join(dir, "legacy.sqlite");
    createLegacyDb(dbPath);

    removeMemoryTables(dbPath);
    removeMemoryTables(dbPath);

    expect(listTables(dbPath)).not.toContain("memories");
    expect(listTables(dbPath)).not.toContain("memories_vec");
  });

  it("only affects the explicitly passed database file", () => {
    const dir = createTmpDir();
    const targetPath = path.join(dir, "target.sqlite");
    const untouchedPath = path.join(dir, "untouched.sqlite");
    createLegacyDb(targetPath);
    createLegacyDb(untouchedPath);

    removeMemoryTables(targetPath);

    expect(listTables(targetPath)).not.toContain("memories");
    expect(listTables(untouchedPath)).toContain("memories");
  });

  it("reports the target path, drop result, and backup warning", () => {
    const dir = createTmpDir();
    const dbPath = path.join(dir, "legacy.sqlite");
    createLegacyDb(dbPath);
    const info: string[] = [];
    const errors: string[] = [];

    const exitCode = runRemoveMemoryTablesCli(["--db", dbPath], {
      info: (message) => info.push(message),
      error: (message) => errors.push(message),
    });

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(info.join("\n")).toContain(dbPath);
    expect(info.join("\n")).toContain("Dropped tables: memories_vec, memories");
    expect(info.join("\n")).toContain("back up this SQLite file");
  });
});
