import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { InviteService } from '../src/auth/invite-service.js';
import { openDatabase } from '../src/database/database.js';
import { temporaryConfig } from './helpers.js';

describe('invite registration', () => {
  it('stores a one-time digest, registers exactly once, and audits lifecycle changes', async () => {
    const config = temporaryConfig();
    config.registration.mode = 'invite';
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const auth = new AuthService(database, config, audit);
    const administrator = await auth.register({
      username: 'admin-user',
      displayName: 'Admin',
      password: 'correct horse battery staple',
    });
    const invites = new InviteService(database, audit);
    const token = invites.create(administrator.id, 7);
    const stored = database.prepare('SELECT token_hash AS tokenHash FROM invites').get() as {
      tokenHash: Buffer;
    };
    expect(stored.tokenHash.toString('utf8')).not.toContain(token);
    await expect(
      auth.register({
        username: 'alice',
        displayName: 'Alice',
        password: 'another correct horse password',
        inviteToken: token,
      }),
    ).resolves.toMatchObject({ username: 'alice', isAdmin: false });
    await expect(
      auth.register({
        username: 'bob',
        displayName: 'Bob',
        password: 'yet another correct password',
        inviteToken: token,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const second = invites.create(administrator.id, 1);
    expect(second).not.toBe(token);
    const unused = invites.list().find((invite) => invite.usedAt === null);
    expect(unused).toBeDefined();
    invites.revoke(administrator.id, unused?.id ?? 0);
    expect(invites.list().filter((invite) => invite.usedAt === null)).toHaveLength(0);
    database.close();
  });
});
