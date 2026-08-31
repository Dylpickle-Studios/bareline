import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database/database.js';
import { temporaryConfig } from './helpers.js';

describe('database migrations', () => {
  it('applies idempotently and enforces foreign keys and audit immutability', () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(database.prepare('SELECT count(*) AS count FROM schema_migrations').get()).toEqual({
      count: 17,
    });
    database
      .prepare(
        "INSERT INTO audit_events(action, target_type, created_at) VALUES ('test', 'system', ?)",
      )
      .run(new Date().toISOString());
    expect(() => database.prepare("UPDATE audit_events SET action = 'changed'").run()).toThrow(
      /immutable/,
    );
    database.close();
    const reopened = openDatabase(config.database.path);
    expect(reopened.prepare('SELECT count(*) AS count FROM schema_migrations').get()).toEqual({
      count: 17,
    });
    reopened.close();
    expect(readFileSync(config.database.path).length).toBeGreaterThan(0);
  });
});
