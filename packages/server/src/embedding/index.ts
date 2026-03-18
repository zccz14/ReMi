import Database from "better-sqlite3";

type VecTable = "soul_anchors_vec" | "memories_vec";

export function upsertEmbedding(
  db: Database.Database,
  table: VecTable,
  id: string,
  embedding: number[]
): void {
  // sqlite-vec: delete then insert to implement upsert
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  db.prepare(`INSERT INTO ${table} (id, embedding) VALUES (?, ?)`).run(
    id,
    JSON.stringify(embedding)
  );
}

export function searchSimilar(
  db: Database.Database,
  table: VecTable,
  query: number[],
  topK: number
): { id: string; distance: number }[] {
  const rows = db
    .prepare(
      `SELECT id, distance FROM ${table} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    )
    .all(JSON.stringify(query), topK) as { id: string; distance: number }[];
  return rows;
}

export function deleteEmbedding(
  db: Database.Database,
  table: VecTable,
  id: string
): void {
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
}
