import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService, ExternalIdentityConflictError } from '../src/auth/auth-service.js';
import { ldapUserFilter } from '../src/auth/external-auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { temporaryConfig } from './helpers.js';

describe('external authentication identities', () => {
  it('atomically bootstraps an external identity and reuses only the exact provider subject', () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const auth = new AuthService(database, config, new AuditService(database));
    const first = auth.loginExternal({
      providerId: 'oidc:work',
      subject: 'subject-1',
      username: 'alice',
      displayName: 'Alice',
      email: 'alice@example.test',
      profile: { issuer: 'work' },
      autoCreate: true,
    });
    expect(first.isAdmin).toBe(true);
    expect(
      auth.loginExternal({
        providerId: 'oidc:work',
        subject: 'subject-1',
        username: 'ignored',
        displayName: 'Ignored',
        profile: {},
        autoCreate: false,
      }).id,
    ).toBe(first.id);
    expect(() =>
      auth.loginExternal({
        providerId: 'oidc:other',
        subject: 'subject-2',
        username: 'alice',
        displayName: 'Impostor',
        profile: {},
        autoCreate: true,
      }),
    ).toThrow(ExternalIdentityConflictError);
    database.close();
  });

  it('escapes every LDAP filter metacharacter and rejects dynamic attribute syntax', () => {
    expect(ldapUserFilter('uid', 'alice*)(uid=*)')).toBe('(uid=alice\\2a\\29\\28uid=\\2a\\29)');
    expect(() => ldapUserFilter('uid)(objectClass', 'alice')).toThrow(/attribute/);
  });
});
