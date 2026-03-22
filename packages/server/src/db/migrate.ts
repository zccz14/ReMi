import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export function initializeDatabase(db: Database.Database, embeddingDimensions: number): void {
  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS soul_anchors (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT,
      source TEXT NOT NULL CHECK(source IN ('interview', 'manual')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('interview', 'manual')),
      metadata TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reasoning_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_key TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      recalled_anchors TEXT,
      anchor_selection_strategy TEXT CHECK(anchor_selection_strategy IN ('batch-recall', 'full-injection')),
      created_at INTEGER NOT NULL
    );
  `);

  try {
    db.exec(`
      ALTER TABLE reasoning_messages
      ADD COLUMN anchor_selection_strategy TEXT CHECK(anchor_selection_strategy IN ('batch-recall', 'full-injection'))
    `);
  } catch {
    // column already exists
  }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS soul_anchors_vec USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[${embeddingDimensions}]
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[${embeddingDimensions}]
    );
  `);
}
