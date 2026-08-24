import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app/create-app.js';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { RepositoryMutationService } from '../src/repositories/repository-mutation-service.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

describe('server-rendered repository browsing', () => {
  it('renders a Markdown blob and serves bounded raw content', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const user = await new AuthService(database, config, audit).register({
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse battery staple',
    });
    const git = new GitRunner('git', 10_000, 16 * 1024 * 1024);
    const repositories = new RepositoryService(database, git, config, audit);
    const repository = await repositories.createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'example',
      visibility: 'public',
      initializeReadme: true,
    });
    await new RepositoryMutationService(database, git, repositories, config, audit).commitFile({
      repository,
      actorUserId: user.id,
      branch: 'main',
      filePath: 'docs/guides/install.md',
      content: Buffer.from('# Install\n'),
      message: 'Add installation guide',
    });
    database.close();

    const app = await createApp(config);
    try {
      const repositoryPage = await app.inject({ method: 'GET', url: '/alice/example' });
      expect(repositoryPage.statusCode).toBe(200);
      expect(repositoryPage.body).toContain('<header class="site-header">');
      expect(repositoryPage.body).toContain('<footer class="site-footer">');
      expect(repositoryPage.body).toContain('<article class="readme markdown-body">');
      expect(repositoryPage.body).toContain('git@localhost:alice/example.git');
      expect(repositoryPage.body).toContain('git clone http://localhost:3000/alice/example.git');
      expect(repositoryPage.body).toContain('/alice/example/tree/docs?ref=main');

      const directory = await app.inject({
        method: 'GET',
        url: '/alice/example/tree/docs?ref=main',
      });
      expect(directory.statusCode).toBe(200);
      expect(directory.body).toContain('/alice/example/tree/docs/guides?ref=main');
      expect(directory.body).not.toContain('/alice/example/blob/docs/guides/install.md?ref=main');

      const nestedDirectory = await app.inject({
        method: 'GET',
        url: '/alice/example/tree/docs/guides?ref=main',
      });
      expect(nestedDirectory.statusCode).toBe(200);
      expect(nestedDirectory.body).toContain('/alice/example/blob/docs/guides/install.md?ref=main');

      const page = await app.inject({
        method: 'GET',
        url: '/alice/example/blob/README.md?ref=main',
      });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('<h1 id="example">');
      expect(page.body).toContain(' example</h1>');
      expect(page.headers['content-security-policy']).toContain("default-src 'self'");
      expect(page.body).toContain('/history/README.md?ref=main');
      expect(page.body).toContain('/blame/README.md?ref=main');

      const history = await app.inject({
        method: 'GET',
        url: '/alice/example/history/README.md?ref=main',
      });
      expect(history.statusCode).toBe(200);
      expect(history.body).toContain('Initial commit');

      const raw = await app.inject({ method: 'GET', url: '/alice/example/raw/README.md?ref=main' });
      expect(raw.statusCode).toBe(200);
      expect(raw.body).toBe('# example\n');
      expect(raw.headers['x-content-type-options']).toBe('nosniff');
      expect(raw.headers['content-type']).toContain('text/plain');

      const archive = await app.inject({
        method: 'GET',
        url: '/alice/example/archive?ref=main&format=zip',
      });
      expect(archive.statusCode).toBe(200);
      expect(archive.headers['content-type']).toContain('application/zip');
      expect(archive.rawPayload.subarray(0, 2).toString('ascii')).toBe('PK');
    } finally {
      await app.close();
    }
  });

  it('shows an explicit opt-in for text above the normal preview limit', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const user = await new AuthService(database, config, audit).register({
      username: 'large-owner',
      displayName: 'Large Owner',
      password: 'correct horse battery staple',
    });
    const git = new GitRunner('git', 10_000, 16 * 1024 * 1024);
    const repositories = new RepositoryService(database, git, config, audit);
    const repository = await repositories.createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'large-file',
      visibility: 'public',
      initializeReadme: true,
    });
    await new RepositoryMutationService(database, git, repositories, config, audit).commitFile({
      repository,
      actorUserId: user.id,
      branch: 'main',
      filePath: 'README.md',
      content: Buffer.from(`# Large file\n\n${'content '.repeat(256)}\n`),
      message: 'Expand README',
    });
    database.close();
    config.limits.filePreviewBytes = 1024;
    const app = await createApp(config);
    try {
      const page = await app.inject({
        method: 'GET',
        url: '/large-owner/large-file/blob/README.md?ref=main',
      });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('This file is unusually large');
      expect(page.body).toContain('large=1');
      const optedIn = await app.inject({
        method: 'GET',
        url: '/large-owner/large-file/blob/README.md?ref=main&large=1',
      });
      expect(optedIn.statusCode).toBe(200);
      expect(optedIn.body).toContain('<h1 id="large-file">');
    } finally {
      await app.close();
    }
  });
});
