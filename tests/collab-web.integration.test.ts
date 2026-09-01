import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app/create-app.js';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { RepositoryMutationService } from '../src/repositories/repository-mutation-service.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

type App = Awaited<ReturnType<typeof createApp>>;

async function postForm(
  app: App,
  url: string,
  cookie: string,
  fields: Record<string, string>,
): Promise<Awaited<ReturnType<App['inject']>>> {
  return await app.inject({
    method: 'POST',
    url,
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  });
}

describe('web routes for fork, merge, star, releases, wiki, and insights', () => {
  it('renders and drives every new repository page end to end', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const auth = new AuthService(database, config, audit);
    const alice = await auth.register({
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse battery staple',
    });
    const signedIn = auth.createSession(alice.id);
    const git = new GitRunner('git', 10_000, 16 * 1024 * 1024);
    const repositories = new RepositoryService(database, git, config, audit);
    const mutations = new RepositoryMutationService(database, git, repositories, config, audit);
    const repository = await repositories.createForUser({
      actorUserId: alice.id,
      ownerUserId: alice.id,
      slug: 'demo',
      visibility: 'public',
      initializeReadme: true,
    });
    await mutations.createBranch(repository, alice.id, 'feature', 'main');
    await mutations.commitFile({
      repository,
      actorUserId: alice.id,
      branch: 'feature',
      filePath: 'feature.txt',
      content: Buffer.from('hi\n'),
      message: 'Add feature.txt',
    });
    database.close();

    const app = await createApp(config);
    const cookie = `session=${signedIn.token}`;
    try {
      const repoPage = await app.inject({ method: 'GET', url: '/alice/demo', headers: { cookie } });
      expect(repoPage.statusCode).toBe(200);
      expect(repoPage.body).toContain('/alice/demo/star');
      expect(repoPage.body).toContain('/alice/demo/fork');
      expect(repoPage.body).toContain('/alice/demo/wiki');
      expect(repoPage.body).toContain('/alice/demo/releases');
      expect(repoPage.body).toContain('/alice/demo/insights');

      const star = await postForm(app, '/alice/demo/star', cookie, {
        csrf: signedIn.csrfToken,
        enabled: 'yes',
      });
      expect(star.statusCode).toBe(302);
      const starredPage = await app.inject({
        method: 'GET',
        url: '/alice/demo',
        headers: { cookie },
      });
      expect(starredPage.body).toContain('Unstar · 1');

      const forkForm = await app.inject({
        method: 'GET',
        url: '/alice/demo/fork',
        headers: { cookie },
      });
      expect(forkForm.statusCode).toBe(200);
      const fork = await postForm(app, '/alice/demo/fork', cookie, {
        csrf: signedIn.csrfToken,
        slug: 'demo-fork',
        visibility: 'public',
      });
      expect(fork.statusCode).toBe(302);
      expect(fork.headers.location).toBe('/alice/demo-fork');
      const forkPage = await app.inject({ method: 'GET', url: '/alice/demo-fork' });
      expect(forkPage.statusCode).toBe(200);
      expect(forkPage.body).toContain('forked from');

      const mergeForm = await app.inject({
        method: 'GET',
        url: '/alice/demo/merge?source=feature&target=main',
        headers: { cookie },
      });
      expect(mergeForm.statusCode).toBe(200);
      const merge = await postForm(app, '/alice/demo/merge', cookie, {
        csrf: signedIn.csrfToken,
        source: 'feature',
        target: 'main',
      });
      expect(merge.statusCode).toBe(302);
      const rawAfterMerge = await app.inject({
        method: 'GET',
        url: '/alice/demo/raw/feature.txt?ref=main',
      });
      expect(rawAfterMerge.statusCode).toBe(200);
      expect(rawAfterMerge.body).toBe('hi\n');

      const releasesList = await app.inject({
        method: 'GET',
        url: '/alice/demo/releases',
        headers: { cookie },
      });
      expect(releasesList.statusCode).toBe(200);
      const releaseNew = await app.inject({
        method: 'GET',
        url: '/alice/demo/releases/new',
        headers: { cookie },
      });
      expect(releaseNew.statusCode).toBe(200);
      const releaseCreate = await postForm(app, '/alice/demo/releases', cookie, {
        csrf: signedIn.csrfToken,
        tagName: 'v1.0.0',
        name: 'First release',
        body: 'Notes',
        ref: 'main',
      });
      expect(releaseCreate.statusCode).toBe(302);
      const releasePage = await app.inject({
        method: 'GET',
        url: '/alice/demo/releases/v1.0.0',
        headers: { cookie },
      });
      expect(releasePage.statusCode).toBe(200);
      expect(releasePage.body).toContain('First release');

      const wikiHome = await app.inject({
        method: 'GET',
        url: '/alice/demo/wiki',
        headers: { cookie },
      });
      expect(wikiHome.statusCode).toBe(200);
      expect(wikiHome.body).toContain('has no content yet');
      const wikiEditForm = await app.inject({
        method: 'GET',
        url: '/alice/demo/wiki/Home/edit',
        headers: { cookie },
      });
      expect(wikiEditForm.statusCode).toBe(200);
      const wikiSave = await postForm(app, '/alice/demo/wiki/Home/edit', cookie, {
        csrf: signedIn.csrfToken,
        content: '# Welcome\n',
        message: 'Create Home',
      });
      expect(wikiSave.statusCode).toBe(302);
      const wikiPage = await app.inject({ method: 'GET', url: '/alice/demo/wiki/Home' });
      expect(wikiPage.statusCode).toBe(200);
      expect(wikiPage.body).toContain('Welcome');
      const wikiHistory = await app.inject({
        method: 'GET',
        url: '/alice/demo/wiki/Home/history',
      });
      expect(wikiHistory.statusCode).toBe(200);
      expect(wikiHistory.body).toContain('Create Home');

      const insights = await app.inject({ method: 'GET', url: '/alice/demo/insights' });
      expect(insights.statusCode).toBe(200);
      expect(insights.body).toContain('Contributors');
      expect(insights.body).toContain('Alice');

      const mergeCommitId = String(merge.headers.location).split('/').pop() ?? '';
      const commitPage = await app.inject({
        method: 'GET',
        url: `/alice/demo/commit/${mergeCommitId}`,
        headers: { cookie },
      });
      expect(commitPage.statusCode).toBe(200);
      expect(commitPage.body).toContain('Cherry-pick onto');
      expect(commitPage.body).toContain('Revert onto');
    } finally {
      await app.close();
    }
  });
});
