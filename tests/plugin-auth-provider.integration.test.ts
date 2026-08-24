import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { createApp } from '../src/app/create-app.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { PluginManager } from '../src/plugins/plugin-manager.js';
import { temporaryConfig } from './helpers.js';

describe('plugin authentication providers', () => {
  it('requires an explicit capability and delegates identity/session creation to core', async () => {
    const config = temporaryConfig();
    config.security.masterKey = Buffer.alloc(32, 12).toString('base64url');
    const source = await mkdtemp(join(tmpdir(), 'focused-git-auth-plugin-'));
    await writeFile(
      join(source, 'plugin.yml'),
      `id: test.authentication
name: Test Authentication
version: 1.0.0
apiVersion: 1
runtime: trusted
entrypoint: index.mjs
permissions: [auth.provider]
contributes:
  authenticationProviders:
    - id: local.test
      title: Test directory
      usernameLabel: Directory user
      passwordLabel: Directory password
      autoCreate: true
`,
    );
    await writeFile(
      join(source, 'index.mjs'),
      `export const authenticationProviders = {
  'local.test'({ credentials }) {
    if (credentials.username !== 'plugin-user' || credentials.password !== 'test-password') {
      throw new Error('denied');
    }
    return { subject: 'subject-1', username: 'plugin-user', displayName: 'Plugin User' };
  }
};
`,
    );
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const admin = await new AuthService(database, config, audit).register({
      username: 'site-admin',
      displayName: 'Admin',
      password: 'correct horse battery staple',
    });
    const manager = new PluginManager(database, config, audit);
    await manager.installLocal(admin.id, source, { trustedRiskAccepted: true });
    manager.setEnabled(admin.id, 'test.authentication', true, true);
    database.close();

    let app = await createApp(config);
    let login = await app.inject({ method: 'GET', url: '/login' });
    expect(login.body).not.toContain('Test directory');
    await app.close();

    const permissionDatabase = openDatabase(config.database.path);
    const permissionManager = new PluginManager(
      permissionDatabase,
      config,
      new AuditService(permissionDatabase),
    );
    permissionManager.setPermission(admin.id, 'test.authentication', 'auth.provider', true);
    permissionManager.setEnabled(admin.id, 'test.authentication', true, true);
    permissionDatabase.close();

    app = await createApp(config);
    try {
      login = await app.inject({ method: 'GET', url: '/login' });
      expect(login.body).toContain('Test directory');
      const csrf = /name="csrf" value="([^"]+)"/.exec(login.body)?.[1];
      const csrfCookie = login.cookies.find((cookie) => cookie.name === 'form_csrf');
      expect(csrf).toBeTruthy();
      expect(csrfCookie).toBeTruthy();
      const response = await app.inject({
        method: 'POST',
        url: '/auth/plugins/test.authentication/local.test',
        headers: { cookie: `form_csrf=${csrfCookie?.value ?? ''}` },
        payload: { csrf, username: 'plugin-user', password: 'test-password' },
      });
      expect(response.statusCode).toBe(302);
      expect(response.cookies.some((cookie) => cookie.name === 'session')).toBe(true);
      const verify = openDatabase(config.database.path);
      const identity = verify
        .prepare(
          'SELECT provider_id AS providerId, subject FROM external_identities WHERE provider_id = ?',
        )
        .get('plugin:test.authentication:local.test');
      expect(identity).toEqual({
        providerId: 'plugin:test.authentication:local.test',
        subject: 'subject-1',
      });
      verify.close();
    } finally {
      await app.close();
    }
  });
});
