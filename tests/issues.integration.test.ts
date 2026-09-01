import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app/create-app.js';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { IssueService } from '../src/repositories/issue-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { RepositoryAdminService } from '../src/repositories/repository-admin-service.js';
import { RepositoryEnhancementService } from '../src/repositories/repository-enhancement-service.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

describe('issue tracker HTTP routes', () => {
  it('runs the full create/comment/close/reopen/assign/label lifecycle and hides private issues from non-collaborators', async () => {
    const config = temporaryConfig();
    config.registration.mode = 'open';
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const auth = new AuthService(database, config, audit);
    const owner = await auth.register({
      username: 'owner',
      displayName: 'Owner',
      password: 'correct horse battery staple',
    });
    const collaborator = await auth.register({
      username: 'collaborator',
      displayName: 'Collaborator',
      password: 'correct horse battery staple',
    });
    const reporter = await auth.register({
      username: 'reporter',
      displayName: 'Reporter',
      password: 'correct horse battery staple',
    });
    const stranger = await auth.register({
      username: 'stranger',
      displayName: 'Stranger',
      password: 'correct horse battery staple',
    });
    const git = new GitRunner('git', 10_000, 16 * 1024 * 1024);
    const repositories = new RepositoryService(database, git, config, audit);
    const repository = await repositories.createForUser({
      actorUserId: owner.id,
      ownerUserId: owner.id,
      slug: 'tracker',
      visibility: 'private',
      initializeReadme: true,
    });
    const admin = new RepositoryAdminService(database, repositories, config, audit);
    admin.setGrant(repository, owner.id, 'user', collaborator.id, 'write');
    admin.setGrant(repository, owner.id, 'user', reporter.id, 'read');
    const enhancements = new RepositoryEnhancementService(database, git, repositories, audit);
    const issues = new IssueService(database, repositories, enhancements, audit);
    const label = issues.createLabel(repository, owner.id, 'bug', 'ff0000');

    const ownerSession = auth.createSession(owner.id, 'test');
    const collaboratorSession = auth.createSession(collaborator.id, 'test');
    const reporterSession = auth.createSession(reporter.id, 'test');
    const strangerSession = auth.createSession(stranger.id, 'test');
    database.close();

    const app = await createApp(config);
    try {
      const create = await app.inject({
        method: 'POST',
        url: '/owner/tracker/issues',
        headers: { cookie: `session=${reporterSession.token}` },
        payload: {
          csrf: reporterSession.csrfToken,
          title: 'Widget is broken',
          body: 'It flickers',
        },
      });
      expect(create.statusCode).toBe(302);
      expect(create.headers.location).toBe('/owner/tracker/issues/1');

      const list = await app.inject({
        method: 'GET',
        url: '/owner/tracker/issues',
        headers: { cookie: `session=${ownerSession.token}` },
      });
      expect(list.statusCode).toBe(200);
      expect(list.body).toContain('Widget is broken');

      const comment = await app.inject({
        method: 'POST',
        url: '/owner/tracker/issues/1',
        headers: { cookie: `session=${reporterSession.token}` },
        payload: { csrf: reporterSession.csrfToken, action: 'comment', body: 'Steps to reproduce' },
      });
      expect(comment.statusCode).toBe(302);

      const close = await app.inject({
        method: 'POST',
        url: '/owner/tracker/issues/1',
        headers: { cookie: `session=${reporterSession.token}` },
        payload: { csrf: reporterSession.csrfToken, action: 'close' },
      });
      expect(close.statusCode).toBe(302);

      const reopen = await app.inject({
        method: 'POST',
        url: '/owner/tracker/issues/1',
        headers: { cookie: `session=${reporterSession.token}` },
        payload: { csrf: reporterSession.csrfToken, action: 'reopen' },
      });
      expect(reopen.statusCode).toBe(302);

      const assign = await app.inject({
        method: 'POST',
        url: '/owner/tracker/issues/1',
        headers: { cookie: `session=${collaboratorSession.token}` },
        payload: {
          csrf: collaboratorSession.csrfToken,
          action: 'assign',
          assignee: 'collaborator',
        },
      });
      expect(assign.statusCode).toBe(302);

      const applyLabel = await app.inject({
        method: 'POST',
        url: '/owner/tracker/issues/1',
        headers: { cookie: `session=${collaboratorSession.token}` },
        payload: {
          csrf: collaboratorSession.csrfToken,
          action: 'label',
          [`label:${String(label.id)}`]: 'on',
        },
      });
      expect(applyLabel.statusCode).toBe(302);

      const detail = await app.inject({
        method: 'GET',
        url: '/owner/tracker/issues/1',
        headers: { cookie: `session=${ownerSession.token}` },
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.body).toContain('Steps to reproduce');
      expect(detail.body).toContain('collaborator');
      expect(detail.body).toContain('bug');

      const readOnlyDenied = await app.inject({
        method: 'POST',
        url: '/owner/tracker/issues/1',
        headers: { cookie: `session=${reporterSession.token}` },
        payload: { csrf: reporterSession.csrfToken, action: 'assign', assignee: 'reporter' },
      });
      expect(readOnlyDenied.statusCode).toBe(404);

      const hiddenList = await app.inject({
        method: 'GET',
        url: '/owner/tracker/issues',
        headers: { cookie: `session=${strangerSession.token}` },
      });
      expect(hiddenList.statusCode).toBe(404);

      const hiddenDetail = await app.inject({
        method: 'GET',
        url: '/owner/tracker/issues/1',
        headers: { cookie: `session=${strangerSession.token}` },
      });
      expect(hiddenDetail.statusCode).toBe(404);

      const newIssuePage = await app.inject({
        method: 'GET',
        url: '/owner/tracker/issues/new',
        headers: { cookie: `session=${reporterSession.token}` },
      });
      expect(newIssuePage.statusCode).toBe(200);
      expect(newIssuePage.body).toContain('bug');

      const labelsPage = await app.inject({
        method: 'GET',
        url: '/owner/tracker/labels',
        headers: { cookie: `session=${ownerSession.token}` },
      });
      expect(labelsPage.statusCode).toBe(200);
      expect(labelsPage.body).toContain('bug');
    } finally {
      await app.close();
    }
  });
});
