import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app/create-app.js';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

function multipartBody(
  boundary: string,
  fields: Record<string, string>,
  file?: { field: string; filename: string; content: string },
): Buffer {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    );
  }
  if (file) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: text/plain\r\n\r\n${file.content}\r\n`,
    );
  }
  parts.push(`--${boundary}--\r\n`);
  return Buffer.from(parts.join(''), 'utf8');
}

const rawDiff = [
  'diff --git a/greeting.txt b/greeting.txt',
  'new file mode 100644',
  'index 0000000..3b18e51',
  '--- /dev/null',
  '+++ b/greeting.txt',
  '@@ -0,0 +1 @@',
  '+hello patch',
  '',
].join('\n');

describe('patches web routes', () => {
  it('previews and imports a patch through the web UI, and serves patch downloads', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const auth = new AuthService(database, config, audit);
    const user = await auth.register({
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse battery staple',
    });
    const signedIn = auth.createSession(user.id);
    const repositories = new RepositoryService(
      database,
      new GitRunner('git', 10_000, 16 * 1024 * 1024),
      config,
      audit,
    );
    const repository = await repositories.createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'demo',
      visibility: 'public',
      initializeReadme: true,
    });
    const tipBefore = await repositories.resolveCommit(repository, 'main');
    database.close();

    const app = await createApp(config);
    try {
      const hub = await app.inject({
        method: 'GET',
        url: '/alice/demo/patches',
        headers: { cookie: `session=${signedIn.token}` },
      });
      expect(hub.statusCode).toBe(200);
      expect(hub.body).toContain('/alice/demo/patches/preview');
      expect(hub.body).toContain('Preview import');

      const boundary = 'bareline-test-boundary';
      const previewPayload = multipartBody(boundary, {
        csrf: signedIn.csrfToken,
        branch: 'main',
        patch: rawDiff,
      });
      const preview = await app.inject({
        method: 'POST',
        url: '/alice/demo/patches/preview',
        headers: {
          cookie: `session=${signedIn.token}`,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: previewPayload,
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.body).toContain('Applies cleanly');
      expect(preview.body).toContain('greeting.txt');
      expect(preview.body).toContain('/alice/demo/patches/import');

      const importPayload = new URLSearchParams({
        csrf: signedIn.csrfToken,
        branch: 'main',
        patch: rawDiff,
        message: 'Add greeting file',
      }).toString();
      const imported = await app.inject({
        method: 'POST',
        url: '/alice/demo/patches/import',
        headers: {
          cookie: `session=${signedIn.token}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: importPayload,
      });
      expect(imported.statusCode).toBe(302);
      expect(imported.headers.location).toMatch(/^\/alice\/demo\/commit\/[0-9a-f]{40}$/);
      const commitId = String(imported.headers.location).split('/').at(-1) ?? '';

      const raw = await app.inject({ method: 'GET', url: '/alice/demo/raw/greeting.txt?ref=main' });
      expect(raw.statusCode).toBe(200);
      expect(raw.body).toBe('hello patch\n');

      const commitPatch = await app.inject({
        method: 'GET',
        url: `/alice/demo/commit/${commitId}/patch`,
      });
      expect(commitPatch.statusCode).toBe(200);
      expect(commitPatch.headers['content-disposition']).toContain('.patch');
      expect(commitPatch.body).toContain('diff --git a/greeting.txt b/greeting.txt');
      expect(commitPatch.body).toContain('Subject: [PATCH] Add greeting file');

      const comparePatch = await app.inject({
        method: 'GET',
        url: `/alice/demo/compare/patch?base=${tipBefore}&head=main`,
      });
      expect(comparePatch.statusCode).toBe(200);
      expect(comparePatch.headers['content-disposition']).toContain('.patch');
      expect(comparePatch.body).toContain('diff --git a/greeting.txt b/greeting.txt');

      const commitPage = await app.inject({ method: 'GET', url: `/alice/demo/commit/${commitId}` });
      expect(commitPage.statusCode).toBe(200);
      expect(commitPage.body).toContain(`/alice/demo/commit/${commitId}/patch`);
    } finally {
      await app.close();
    }
  });
});
