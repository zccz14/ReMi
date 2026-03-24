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

    CREATE TABLE IF NOT EXISTS direct_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shared_message_id TEXT NOT NULL,
      party_a_key TEXT NOT NULL,
      party_b_key TEXT NOT NULL,
      sender_key TEXT NOT NULL,
      sender_kind TEXT NOT NULL CHECK(sender_kind IN ('owner', 'avatar')),
      ciphertext_a TEXT NOT NULL,
      ciphertext_b TEXT NOT NULL,
      ciphertext_c TEXT NOT NULL,
      message_hash TEXT NOT NULL,
      prev_message_hash TEXT,
      created_at INTEGER NOT NULL,
      delivered_at_a INTEGER,
      delivered_at_b INTEGER,
      read_at_a INTEGER,
      read_at_b INTEGER,
      attested_at_a INTEGER,
      attested_at_b INTEGER,
      sign_a TEXT,
      sign_b TEXT,
      status_reason_a TEXT,
      status_reason_b TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_direct_messages_shared_message_id
      ON direct_messages(shared_message_id);

    CREATE INDEX IF NOT EXISTS idx_direct_messages_parties_created
      ON direct_messages(party_a_key, party_b_key, id DESC);
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
