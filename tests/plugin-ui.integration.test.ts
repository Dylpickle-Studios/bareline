import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { createApp } from '../src/app/create-app.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { PluginManager } from '../src/plugins/plugin-manager.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

describe('plugin UI contributions', () => {
  it('dispatches bounded file/admin views and serves manifest-only themes', async () => {
    const config = temporaryConfig();
    config.security.masterKey = Buffer.alloc(32, 9).toString('base64url');
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const auth = new AuthService(database, config, audit);
    const user = await auth.register({
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse battery staple',
    });
    await new RepositoryService(
      database,
      new GitRunner('git', 10_000, 16 * 1024 * 1024),
      config,
      audit,
    ).createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'example',
      visibility: 'private',
      initializeReadme: true,
    });
    const plugins = new PluginManager(database, config, audit);
    await plugins.installLocal(user.id, resolve('plugins/example'), { trustedRiskAccepted: true });
    for (const capability of [
      'repositoryContents.read',
      'ui.repository',
      'ui.global',
      'settings.read',
    ])
      plugins.setPermission(user.id, 'example.word-count', capability, true);
    plugins.setEnabled(user.id, 'example.word-count', true, true);
    const session = auth.createSession(user.id);
    database.close();

    const app = await createApp(config);
    const cookie = { cookie: `session=${session.token}` };
    try {
      const blob = await app.inject({
        method: 'GET',
        url: '/alice/example/blob/README.md?ref=main',
        headers: cookie,
      });
      expect(blob.body).toContain('Word-count preview');
      const rendered = await app.inject({
        method: 'GET',
        url: '/alice/example/plugins/example.word-count/renderers/word-count.preview/README.md?ref=main',
        headers: cookie,
      });
      expect(rendered.statusCode).toBe(200);
      expect(rendered.body).toContain('Words');
      const admin = await app.inject({
        method: 'GET',
        url: '/admin/plugins/example.word-count/pages/word-count.status',
        headers: cookie,
      });
      expect(admin.statusCode).toBe(200);
      expect(admin.body).toContain('checked integration is active');
      const appearance = await app.inject({
        method: 'POST',
        url: '/settings/appearance',
        headers: cookie,
        payload: {
          csrf: session.csrfToken,
          theme: 'dark',
          pluginTheme: 'example.word-count:ink',
          accent: 'violet',
          uiFont: 'system',
          codeFont: 'system',
        },
      });
      expect(appearance.statusCode).toBe(302);
      const home = await app.inject({ method: 'GET', url: '/', headers: cookie });
      expect(home.body).toContain('/plugin-themes/example.word-count/ink.css');
      const css = await app.inject({
        method: 'GET',
        url: '/plugin-themes/example.word-count/ink.css',
      });
      expect(css.statusCode).toBe(200);
      expect(css.headers['content-type']).toContain('text/css');
      expect(css.body).toContain('--accent:#67c7a5');
      expect(css.body).not.toContain('<');
    } finally {
      await app.close();
    }
  });
});
