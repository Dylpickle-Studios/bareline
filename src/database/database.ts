import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { migrations } from './migrations.js';

export type Database = BetterSqlite3.Database;

export function openDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
  const database = new BetterSqlite3(path);
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.pragma('busy_timeout = 5000');
  migrate(database);
  return database;
}

export function migrate(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const applied = database
    .prepare('SELECT version, checksum FROM schema_migrations ORDER BY version')
    .all() as { version: number; checksum: string }[];
  const checksums = new Map(applied.map((row) => [row.version, row.checksum]));
  for (const migration of migrations) {
    const checksum = createHash('sha256').update(migration.sql).digest('hex');
    const existing = checksums.get(migration.version);
    if (existing && existing !== checksum) {
      throw new Error(`Migration ${String(migration.version)} checksum changed`);
    }
    if (existing) continue;
    database.transaction(() => {
      database.exec(migration.sql);
      database
        .prepare(
          'INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        )
        .run(migration.version, migration.name, checksum, new Date().toISOString());
    })();
  }
}
