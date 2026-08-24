import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { PasskeyService } from '../src/auth/passkey-service.js';
import { openDatabase } from '../src/database/database.js';
import { temporaryConfig } from './helpers.js';

describe('passkey challenge lifecycle', () => {
  it('creates account-bound, short-lived registration challenges', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const createdAt = new Date().toISOString();
    const result = database
      .prepare(
        "INSERT INTO users(username, display_name, status, is_admin, created_at) VALUES ('alice', 'Alice', 'active', 0, ?)",
      )
      .run(createdAt);
    const userId = Number(result.lastInsertRowid);
    const service = new PasskeyService(database, config, new AuditService(database));
    const options = (await service.registrationOptions(userId)) as {
      challenge: string;
      rp: { id: string };
    };
    expect(options.rp.id).toBe('localhost');
    const stored = database
      .prepare(
        'SELECT purpose, user_id AS userId, expires_at AS expiresAt FROM authentication_challenges WHERE challenge = ?',
      )
      .get(options.challenge) as { purpose: string; userId: number; expiresAt: string };
    expect(stored.purpose).toBe('passkey-registration');
    expect(stored.userId).toBe(userId);
    expect(new Date(stored.expiresAt).getTime()).toBeGreaterThan(Date.now());
    database.close();
  });
});
