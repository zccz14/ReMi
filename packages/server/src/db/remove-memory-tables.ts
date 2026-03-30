import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

type CliIO = {
  info: (message: string) => void;
  error: (message: string) => void;
};

function parseDbPathArg(argv: string[]): string {
  const dbFlagIndex = argv.indexOf("--db");
  if (dbFlagIndex === -1 || dbFlagIndex === argv.length - 1) {
    throw new Error("Missing required --db /absolute/path/to/user.sqlite argument");
  }

  const dbPath = argv[dbFlagIndex + 1];
  if (!path.isAbsolute(dbPath)) {
    throw new Error(`Database path must be absolute: ${dbPath}`);
  }
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database file does not exist: ${dbPath}`);
  }

  const stats = fs.statSync(dbPath);
  if (!stats.isFile()) {
    throw new Error(`Database path must point to a file: ${dbPath}`);
  }

  return dbPath;
}

export function removeMemoryTables(dbPath: string): { droppedTables: string[] } {
  const db = new Database(dbPath);

  try {
    sqliteVec.load(db);
    db.transaction(() => {
      db.exec("DROP TABLE IF EXISTS memories_vec");
      db.exec("DROP TABLE IF EXISTS memories");
    })();
  } finally {
    db.close();
  }

  return { droppedTables: ["memories_vec", "memories"] };
}

export function runRemoveMemoryTablesCli(argv: string[], io: CliIO): number {
  try {
    const dbPath = parseDbPathArg(argv);

    io.info(`Target DB: ${dbPath}`);
    io.info("Warning: back up this SQLite file before running this migration in production.");

    const result = removeMemoryTables(dbPath);
    io.info(`Dropped tables: ${result.droppedTables.join(", ")}`);

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.error(`Failed to remove legacy memory tables: ${message}`);
    return 1;
  }
}

async function main(argv: string[]): Promise<void> {
  const exitCode = runRemoveMemoryTablesCli(argv, {
    info: (message) => console.log(message),
    error: (message) => console.error(message),
  });
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2));
}
