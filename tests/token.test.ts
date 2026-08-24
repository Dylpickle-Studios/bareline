import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { TokenService } from '../src/auth/token-service.js';
import { openDatabase } from '../src/database/database.js';
import { temporaryConfig } from './helpers.js';

describe('personal access tokens', () => {
  it('shows a token once and stores only its digest', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const user = await new AuthService(database, config, new AuditService(database)).register({
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse battery staple',
    });
    const service = new TokenService(database);
    const raw = service.create({
      userId: user.id,
      name: 'Git client',
      scopes: ['repository:read'],
    });
    expect(raw).toMatch(/^ghp_/);
    expect(service.verify(raw, 'repository:read')?.userId).toBe(user.id);
    expect(service.verify(raw, 'repository:write')).toBeNull();
    const stored = database.prepare('SELECT token_hash FROM tokens').get() as {
      token_hash: Buffer;
    };
    expect(stored.token_hash.toString('utf8')).not.toContain(raw);
    database.close();
  });
});
