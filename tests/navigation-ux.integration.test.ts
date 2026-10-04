import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app/create-app.js';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { RepositoryMutationService } from '../src/repositories/repository-mutation-service.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

const identity = ['-c', 'user.name=Alice', '-c', 'user.email=alice@example.test'];

describe('repository navigation and listing experience', () => {
  it('shows one tab bar on every repository page, paginates history, and filters Explore', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const auth = new AuthService(database, config, audit);
    const user = await auth.register({
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
      description: 'Pagination fixture',
      initializeReadme: true,
    });
    await repositories.createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'other-project',
      visibility: 'public',
      description: 'Something else entirely',
    });
    const mutations = new RepositoryMutationService(database, git, repositories, config, audit);
    await mutations.commitFile({
      repository,
      actorUserId: user.id,
      branch: 'main',
      filePath: 'docs/README.md',
      content: Buffer.from('# Docs\n\n![diagram](images/flow.png)\n\n[guide](guide.md)\n'),
      message: 'Add docs',
    });
    // Build 35 more commits directly on the bare repository so the history spans two pages.
    const path = await repositories.storagePath(repository);
    let parent = (await git.run(['--git-dir', path, 'rev-parse', 'HEAD'])).stdout
      .toString('ascii')
      .trim();
    const tree = (await git.run(['--git-dir', path, 'rev-parse', 'HEAD^{tree}'])).stdout
      .toString('ascii')
      .trim();
    for (let index = 1; index <= 35; index += 1) {
      parent = (
        await git.run([...identity, '--git-dir', path, 'commit-tree', tree, '-p', parent], {
          input: Buffer.from(`Filler commit ${String(index)}\n`),
        })
      ).stdout
        .toString('ascii')
        .trim();
    }
    await git.run(['--git-dir', path, 'update-ref', 'refs/heads/main', parent]);
    await git.run(['--git-dir', path, 'tag', 'v1.0.0', parent]);
    const session = auth.createSession(user.id);
    database.close();

    const app = await createApp(config);
    try {
      const cookie = { cookie: `session=${session.token}` };
      const tabBar = /<nav class="repo-bar" aria-label="Repository">/g;
      for (const url of [
        '/alice/example',
        '/alice/example/tree/docs?ref=main',
        '/alice/example/blob/docs/README.md?ref=main',
        '/alice/example/commits',
        '/alice/example/branches',
        '/alice/example/tags',
        '/alice/example/compare',
        '/alice/example/issues',
        '/alice/example/wiki',
        '/alice/example/releases',
        '/alice/example/insights',
      ]) {
        const page = await app.inject({ method: 'GET', url, headers: cookie });
        expect(page.statusCode, url).toBe(200);
        expect(page.body.match(tabBar)?.length, url).toBe(1);
        expect(page.body, url).toContain('<title>');
        expect(page.body, url).toContain('alice/example');
      }
      const tags = await app.inject({ method: 'GET', url: '/alice/example/tags', headers: cookie });
      expect(tags.body).toMatch(/<a href="\/alice\/example\/tags" aria-current="page">Tags<\/a>/);
      expect(tags.body).toContain('v1.0.0');
      expect(tags.body).toContain('Unsigned');
      const settings = await app.inject({
        method: 'GET',
        url: '/alice/example/settings',
        headers: cookie,
      });
      expect(settings.body).toMatch(/aria-current="page">Settings<\/a>/);
      const anonymous = await app.inject({ method: 'GET', url: '/alice/example' });
      expect(anonymous.body).not.toContain('>Settings</a>');

      const firstPage = await app.inject({ method: 'GET', url: '/alice/example/commits?ref=main' });
      expect(firstPage.body).toContain('Filler commit 35');
      expect(firstPage.body).not.toContain('Filler commit 5<');
      expect(firstPage.body).toContain('rel="next"');
      expect(firstPage.body).not.toContain('rel="prev"');
      const secondPage = await app.inject({
        method: 'GET',
        url: '/alice/example/commits?ref=main&page=2',
      });
      expect(secondPage.body).toContain('Initial commit');
      expect(secondPage.body).toContain('rel="prev"');
      expect(secondPage.body).not.toContain('rel="next"');
      const history = await app.inject({
        method: 'GET',
        url: '/alice/example/history/docs/README.md?ref=main',
      });
      expect(history.statusCode).toBe(200);
      expect(history.body).toContain('Add docs');
      expect(history.body).not.toContain('rel="next"');

      const blob = await app.inject({
        method: 'GET',
        url: '/alice/example/blob/docs/README.md?ref=main',
      });
      expect(blob.body).toContain('src="/alice/example/raw/docs/images/flow.png?ref=main"');
      expect(blob.body).toContain('href="/alice/example/blob/docs/guide.md?ref=main"');
      const tree = await app.inject({ method: 'GET', url: '/alice/example/tree/docs?ref=main' });
      expect(tree.body).toContain('aria-label="Parent directory"');
      expect(tree.body).toMatch(/<span class="size">\d+ B<\/span>/);
      const landing = await app.inject({ method: 'GET', url: '/alice/example' });
      expect(landing.body).toMatch(/<span class="size">\d+ B<\/span>/);

      const explore = await app.inject({ method: 'GET', url: '/explore?q=pagination' });
      expect(explore.statusCode).toBe(200);
      expect(explore.body).toContain('alice/example');
      expect(explore.body).not.toContain('alice/other-project');
      expect(explore.body).toContain('value="pagination"');
      const everything = await app.inject({ method: 'GET', url: '/explore' });
      expect(everything.body).toContain('alice/other-project');
      expect(everything.body).not.toContain('class="pagination"');

      const home = await app.inject({ method: 'GET', url: '/', headers: cookie });
      expect(home.body).toContain('Owned by you');
      expect(home.body).toContain('other-project');
      expect(home.body).toContain('Create repository');
      expect(home.body).toContain('data-shortcut-key');
      const visitor = await app.inject({ method: 'GET', url: '/' });
      expect(visitor.body).toContain('Create your account');
      expect(visitor.body).not.toContain('Owned by you');
      expect(visitor.body).toContain('/assets/app.css?v=');

      const palette = await app.inject({
        method: 'GET',
        url: '/api/v1/palette?q=plugin',
        headers: cookie,
      });
      const paletteItems = palette.json<{ items: { title: string }[] }>().items;
      expect(paletteItems.map((item) => item.title)).toContain('Plugin documentation');
    } finally {
      await app.close();
    }
  }, 60_000);
});
