import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app/create-app.js';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { temporaryConfig } from './helpers.js';

describe('credential lifecycle', () => {
  it('keeps the current session and revokes every other session after passkey removal', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const auth = new AuthService(database, config, new AuditService(database));
    const user = await auth.register({
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse battery staple',
    });
    const current = auth.createSession(user.id, 'current browser');
    auth.createSession(user.id, 'other browser');
    const passkeyId = Buffer.from('credential-id');
    database
      .prepare(
        "INSERT INTO passkeys(id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, 0, '[]', 'Key', ?)",
      )
      .run(passkeyId, user.id, Buffer.from('public-key'), new Date().toISOString());
    database.close();

    const app = await createApp(config);
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/settings/passkeys/${encodeURIComponent(passkeyId.toString('base64url'))}`,
        headers: {
          cookie: `session=${current.token}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: new URLSearchParams({ csrf: current.csrfToken, action: 'remove' }).toString(),
      });
      expect(response.statusCode).toBe(302);
      const verification = openDatabase(config.database.path);
      const sessions = new AuthService(verification, config, new AuditService(verification));
      expect(sessions.sessions(user.id)).toHaveLength(1);
      expect(sessions.resolveSession(current.token)?.user.id).toBe(user.id);
      expect(verification.prepare('SELECT count(*) AS count FROM passkeys').get()).toMatchObject({
        count: 0,
      });
      verification.close();
    } finally {
      await app.close();
    }
  });
});
