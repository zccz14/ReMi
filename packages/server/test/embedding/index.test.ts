import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initializeDatabase } from "../../src/db/migrate.js";
import { upsertEmbedding, searchSimilar, deleteEmbedding } from "../../src/embedding/index.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("vector index operations", () => {
  const tmpFiles: string[] = [];
  const DIM = 4; // small dimension for testing

  function createTestDb(): Database.Database {
    const p = path.join(os.tmpdir(), `remi-vec-test-${crypto.randomUUID()}.sqlite`);
    tmpFiles.push(p);
    const db = new Database(p);
    initializeDatabase(db, DIM);
    return db;
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

  it("should upsert and search embeddings", () => {
    const db = createTestDb();
    upsertEmbedding(db, "soul_anchors_vec", "id1", [1, 0, 0, 0]);
    upsertEmbedding(db, "soul_anchors_vec", "id2", [0, 1, 0, 0]);
    upsertEmbedding(db, "soul_anchors_vec", "id3", [0.9, 0.1, 0, 0]);

    const results = searchSimilar(db, "soul_anchors_vec", [1, 0, 0, 0], 2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("id1"); // most similar
    db.close();
  });

  it("should upsert (update) existing embedding", () => {
    const db = createTestDb();
    upsertEmbedding(db, "soul_anchors_vec", "id1", [1, 0, 0, 0]);
    upsertEmbedding(db, "soul_anchors_vec", "id1", [0, 1, 0, 0]); // update

    const results = searchSimilar(db, "soul_anchors_vec", [0, 1, 0, 0], 1);
    expect(results[0].id).toBe("id1");
    db.close();
  });

  it("should delete embedding", () => {
    const db = createTestDb();
    upsertEmbedding(db, "soul_anchors_vec", "id1", [1, 0, 0, 0]);
    deleteEmbedding(db, "soul_anchors_vec", "id1");

    const results = searchSimilar(db, "soul_anchors_vec", [1, 0, 0, 0], 10);
    expect(results).toHaveLength(0);
    db.close();
  });
});
