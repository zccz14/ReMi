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

  it("should create direct_messages table", () => {
    const dbPath = createTmpDb();
    const db = new Database(dbPath);
    initializeDatabase(db, 1536);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("direct_messages");
    expect(names).not.toContain("reasoning_messages");
    const info = db.prepare("PRAGMA table_info(direct_messages)").all();
    const columns = (info as { name: string }[]).map((c) => c.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "id",
        "shared_message_id",
        "party_a_key",
        "party_b_key",
        "sender_key",
        "sender_kind",
        "ciphertext_a",
        "ciphertext_b",
        "ciphertext_c",
        "message_hash",
        "prev_message_hash",
        "created_at",
        "delivered_at_a",
        "delivered_at_b",
        "read_at_a",
        "read_at_b",
        "attested_at_a",
        "attested_at_b",
        "sign_a",
        "sign_b",
        "status_reason_a",
        "status_reason_b",
      ]),
    );
    db.close();
  });

  it("should create approval persistence tables and idempotency index", () => {
    const dbPath = createTmpDb();
    const db = new Database(dbPath);
    initializeDatabase(db, 1536);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[];
    const names = tables.map((t) => t.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "soul_candidate_queue",
        "approval_last_actions",
        "approval_requests",
      ]),
    );

    const indexes = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='approval_requests'",
      )
      .all() as { name: string; sql: string | null }[];

    const requestIndex = indexes.find(
      (index) => index.name === "idx_approval_requests_owner_candidate_request",
    );

    expect(requestIndex).toEqual(
      expect.objectContaining({
        name: "idx_approval_requests_owner_candidate_request",
        sql: expect.stringContaining("UNIQUE INDEX"),
      }),
    );
    expect(requestIndex?.sql ?? "").toContain("owner_key, candidate_id, request_id");

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
