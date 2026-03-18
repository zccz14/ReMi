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
  `);

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
