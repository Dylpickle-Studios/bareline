import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { RuntimeSettingsService } from '../src/admin/runtime-settings-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { temporaryConfig } from './helpers.js';

describe('runtime application settings', () => {
  it('validates, persists, audits, and reapplies the safe runtime subset', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const admin = await new AuthService(database, config, audit).register({
      username: 'settings-admin',
      displayName: 'Settings Admin',
      password: 'correct horse battery staple',
    });
    const service = new RuntimeSettingsService(database, config, audit);
    const changed = { ...service.load(), registrationMode: 'invite' as const, diffLines: 12_345 };
    service.update(admin.id, changed);
    expect(config.registration.mode).toBe('invite');
    expect(config.limits.diffLines).toBe(12_345);
    config.registration.mode = 'closed';
    config.limits.diffLines = 500;
    expect(service.load()).toMatchObject({ registrationMode: 'invite', diffLines: 12_345 });
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action = 'application.settingsChanged'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(() => service.update(admin.id, { ...changed, diffFiles: 10_001 })).toThrow(
      'Diff file limit',
    );
    database.close();
  });
});
