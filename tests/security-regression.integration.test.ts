import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app/create-app.js';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

describe('cross-boundary security regressions', () => {
  it('does not disclose private repositories and rejects session mutations without CSRF', async () => {
    const config = temporaryConfig();
    config.registration.mode = 'open';
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const auth = new AuthService(database, config, audit);
    const user = await auth.register({
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse battery staple',
    });
    await auth.login('alice', 'correct horse battery staple');
    const signedIn = auth.createSession(user.id);
    await new RepositoryService(
      database,
      new GitRunner('git', 10_000, 16 * 1024 * 1024),
      config,
      audit,
    ).createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'secret',
      visibility: 'private',
      initializeReadme: true,
    });
    database.close();

    const app = await createApp(config);
    try {
      const authenticated = await app.inject({
        method: 'GET',
        url: '/settings/appearance',
        headers: { cookie: `session=${signedIn.token}` },
      });
      expect(authenticated.statusCode).toBe(200);
      const hidden = await app.inject({ method: 'GET', url: '/alice/secret' });
      expect(hidden.statusCode).toBe(404);
      expect(hidden.body).not.toContain('secret');

      const csrf = await app.inject({
        method: 'POST',
        url: '/repositories/new',
        headers: { cookie: `session=${signedIn.token}` },
        payload: {
          slug: 'forged',
          owner: 'user:alice',
          visibility: 'private',
          initializeReadme: 'yes',
        },
      });
      expect(csrf.statusCode).toBe(403);
      expect(app.printRoutes()).not.toContain('hook');
    } finally {
      await app.close();
    }
  });

  it('refuses secret-shaped audit metadata', () => {
    const database = openDatabase(temporaryConfig().database.path);
    const audit = new AuditService(database);
    expect(() => {
      audit.record({
        action: 'security.test',
        targetType: 'system',
        metadata: { apiToken: 'must-not-be-logged' },
      });
    }).toThrow(/secret-like/);
    database.close();
  });

  it('protects audited runtime settings with administrator authorization and CSRF', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const auth = new AuthService(database, config, audit);
    const admin = await auth.register({
      username: 'root-admin',
      displayName: 'Administrator',
      password: 'correct horse battery staple',
    });
    const session = auth.createSession(admin.id);
    database.close();
    const app = await createApp(config);
    try {
      expect((await app.inject({ method: 'GET', url: '/admin/settings' })).statusCode).toBe(403);
      const withoutCsrf = await app.inject({
        method: 'POST',
        url: '/admin/settings',
        headers: { cookie: `session=${session.token}` },
        payload: { registrationMode: 'open' },
      });
      expect(withoutCsrf.statusCode).toBe(403);
      const page = await app.inject({
        method: 'GET',
        url: '/admin/settings',
        headers: { cookie: `session=${session.token}` },
      });
      expect(page.statusCode).toBe(200);
      expect(page.body).not.toContain('clientSecret');
      const updated = await app.inject({
        method: 'POST',
        url: '/admin/settings',
        headers: { cookie: `session=${session.token}` },
        payload: {
          csrf: session.csrfToken,
          registrationMode: 'invite',
          anonymousPublicRepositories: 'yes',
          sessionDays: '30',
          repositoryTrashDays: '14',
          filePreviewBytes: '2097152',
          diffBytes: '10485760',
          diffLines: '20000',
          diffFiles: '500',
          diffFileBytes: '2097152',
          archiveBytes: '1073741824',
          lfsObjectBytes: '5368709120',
        },
      });
      expect(updated.statusCode).toBe(302);
      expect(config.registration.mode).toBe('invite');
    } finally {
      await app.close();
    }
  });
});
