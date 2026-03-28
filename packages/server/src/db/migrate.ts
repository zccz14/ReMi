import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export function initializeDatabase(db: Database.Database, embeddingDimensions: number): void {
  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS soul_anchors (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT,
      source TEXT NOT NULL CHECK(source IN ('interview', 'manual', 'reading')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('interview', 'manual', 'reading')),
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

    CREATE TABLE IF NOT EXISTS public_profile (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      bio TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS public_profile_avatar (
      id TEXT PRIMARY KEY,
      blob BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS goal_nodes (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      type TEXT NOT NULL CHECK(type IN ('goal', 'session')),
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('todo', 'running', 'blocked', 'done', 'cancelled')),
      dependency_ids TEXT NOT NULL CHECK(json_valid(dependency_ids) AND json_type(dependency_ids) = 'array'),
      execution_base_url TEXT,
      external_session_id TEXT,
      CHECK(
        (type = 'goal' AND status != 'running' AND execution_base_url IS NULL AND external_session_id IS NULL)
        OR
        (type = 'session' AND execution_base_url IS NOT NULL AND external_session_id IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS soul_candidate_queue (
      id TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT,
      source TEXT NOT NULL CHECK(source IN ('interview', 'manual', 'reading')),
      source_ref TEXT,
      source_snapshot TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approval_last_actions (
      owner_key TEXT PRIMARY KEY,
      action_id TEXT NOT NULL,
      candidate_snapshot TEXT NOT NULL,
      rollback_payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      action TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_direct_messages_shared_message_id
      ON direct_messages(shared_message_id);

    CREATE INDEX IF NOT EXISTS idx_direct_messages_parties_created
      ON direct_messages(party_a_key, party_b_key, id DESC);

    CREATE INDEX IF NOT EXISTS idx_goal_nodes_parent_id
      ON goal_nodes(parent_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_requests_owner_candidate_request
      ON approval_requests(owner_key, candidate_id, request_id);
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
