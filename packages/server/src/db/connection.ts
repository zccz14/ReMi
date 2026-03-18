import Database from "better-sqlite3";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { LRUCache } from "lru-cache";
import * as fs from "node:fs";
import * as path from "node:path";
import { initializeDatabase } from "./migrate.js";

interface CachedConnection {
  raw: Database.Database;
  drizzle: BetterSQLite3Database;
}

interface ConnectionManagerOptions {
  maxSize?: number;
  embeddingDimensions?: number;
}

export class ConnectionManager {
  private cache: LRUCache<string, CachedConnection>;
  public readonly dataDir: string;
  private embeddingDimensions: number;

  constructor(dataDir: string, options: ConnectionManagerOptions = {}) {
    this.dataDir = dataDir;
    this.embeddingDimensions = options.embeddingDimensions ?? 1536;
    this.cache = new LRUCache<string, CachedConnection>({
      max: options.maxSize ?? 100,
      dispose: (value) => {
        try { value.raw.close(); } catch {}
      },
    });
  }

  getConnection(pubKey: string, options?: { create?: boolean }): CachedConnection {
    const cached = this.cache.get(pubKey);
    if (cached) return cached;

    const dbPath = path.join(this.dataDir, `${pubKey}.sqlite`);
    const exists = fs.existsSync(dbPath);

    if (!exists && !options?.create) {
      throw new Error(`Soul not found: ${pubKey}`);
    }

    const raw = new Database(dbPath);
    initializeDatabase(raw, this.embeddingDimensions);

    const conn: CachedConnection = {
      raw,
      drizzle: drizzle(raw),
    };
    this.cache.set(pubKey, conn);
    return conn;
  }

  removeConnection(pubKey: string): void {
    const cached = this.cache.get(pubKey);
    if (cached) {
      try { cached.raw.close(); } catch {}
      this.cache.delete(pubKey);
    }
  }

  soulExists(pubKey: string): boolean {
    return fs.existsSync(path.join(this.dataDir, `${pubKey}.sqlite`));
  }

  closeAll(): void {
    this.cache.clear();
  }
}
