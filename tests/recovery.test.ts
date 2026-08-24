import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { RecoveryService } from '../src/auth/recovery-service.js';
import { openDatabase } from '../src/database/database.js';
import { temporaryConfig } from './helpers.js';

describe('account recovery', () => {
  it('stores only code digests, consumes once, changes the password, and revokes sessions', async () => {
    const config = temporaryConfig();
    config.registration.mode = 'open';
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const auth = new AuthService(database, config, audit);
    const user = await auth.register({
      username: 'alice',
      displayName: 'Alice',
      password: 'old-password-value',
    });
    auth.createSession(user.id, 'test');
    const recovery = new RecoveryService(database, audit);
    const codes = recovery.generate(user.id);
    expect(codes).toHaveLength(10);
    const stored = database
      .prepare('SELECT code_hash FROM recovery_codes WHERE user_id = ? LIMIT 1')
      .get(user.id) as { code_hash: Buffer };
    expect(stored.code_hash.toString('utf8')).not.toContain(codes[0] ?? 'impossible');
    await recovery.resetPassword('alice', codes[0] ?? '', 'new-password-value');
    expect(auth.sessions(user.id)).toHaveLength(0);
    await expect(auth.login('alice', 'new-password-value')).resolves.toMatchObject({ id: user.id });
    await expect(
      recovery.resetPassword('alice', codes[0] ?? '', 'another-password'),
    ).rejects.toThrow(/not accepted/);
    database.close();
  });

  it('lets an administrator issue one non-disclosed replacement code', async () => {
    const config = temporaryConfig();
    config.registration.mode = 'open';
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const auth = new AuthService(database, config, audit);
    const administrator = await auth.register({
      username: 'rootadmin',
      displayName: 'Admin',
      password: 'correct horse battery staple',
    });
    const user = await auth.register({
      username: 'alice',
      displayName: 'Alice',
      password: 'another correct horse password',
    });
    const recovery = new RecoveryService(database, audit);
    const oldCodes = recovery.generate(user.id);
    const issued = recovery.issueAdministratorCode(administrator.id, user.id);
    expect(issued).toMatch(/^[a-z0-9_-]{5}-[a-z0-9_-]{5}-[a-z0-9_-]+$/);
    expect(recovery.count(user.id)).toBe(1);
    await expect(
      recovery.resetPassword('alice', oldCodes[0] ?? '', 'a replacement password'),
    ).rejects.toThrow();
    await recovery.resetPassword('alice', issued, 'a replacement password');
    const event = database
      .prepare(
        "SELECT actor_user_id, metadata_json FROM audit_events WHERE action = 'recoveryCode.administratorIssued'",
      )
      .get() as { actor_user_id: number; metadata_json: string };
    expect(event.actor_user_id).toBe(administrator.id);
    expect(event.metadata_json).not.toContain(issued);
    database.close();
  });
});
