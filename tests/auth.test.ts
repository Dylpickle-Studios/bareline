import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { temporaryConfig } from './helpers.js';

describe('authentication', () => {
  it('bootstraps exactly one administrator and stores no plaintext password or session token', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const auth = new AuthService(database, config, new AuditService(database));
    const user = await auth.register({
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse battery staple',
    });
    expect(user.isAdmin).toBe(true);
    await expect(
      auth.register({
        username: 'bob',
        displayName: 'Bob',
        password: 'another excellent password',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const credential = database
      .prepare('SELECT password_hash FROM users WHERE id = ?')
      .get(user.id) as { password_hash: string };
    expect(credential.password_hash).not.toContain('correct horse');
    const created = auth.createSession(user.id);
    const stored = database.prepare('SELECT token_hash FROM sessions').get() as {
      token_hash: Buffer;
    };
    expect(stored.token_hash.toString()).not.toContain(created.token);
    expect(auth.resolveSession(created.token)?.user.id).toBe(user.id);
    database.close();
  });
});
