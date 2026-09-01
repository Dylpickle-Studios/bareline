import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitBrowser } from '../src/git/git-browser.js';
import { GitRunner } from '../src/git/git-runner.js';
import { IssueService } from '../src/repositories/issue-service.js';
import { RepositoryEnhancementService } from '../src/repositories/repository-enhancement-service.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { SearchService } from '../src/search/search-service.js';
import { temporaryConfig } from './helpers.js';

describe('issue search indexing', () => {
  it('indexes issues alongside Git content and filters private-repo issues from other users', async () => {
    const config = temporaryConfig();
    config.registration.mode = 'open';
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const owner = await new AuthService(database, config, audit).register({
      username: 'owner',
      displayName: 'Owner',
      password: 'correct horse battery staple',
    });
    const outsider = await new AuthService(database, config, audit).register({
      username: 'outsider',
      displayName: 'Outsider',
      password: 'another correct horse password',
    });
    const git = new GitRunner('git', 10_000, 16 * 1024 * 1024);
    const repositories = new RepositoryService(database, git, config, audit);
    const enhancements = new RepositoryEnhancementService(database, git, repositories, audit);
    const issues = new IssueService(database, repositories, enhancements, audit);
    const repository = await repositories.createForUser({
      actorUserId: owner.id,
      ownerUserId: owner.id,
      slug: 'private-tracker',
      visibility: 'private',
      initializeReadme: true,
    });
    const created = issues.create(repository, owner.id, {
      title: 'Widget rendering glitch',
      body: 'The widget flickers on load',
    });
    const search = new SearchService(
      database,
      git,
      repositories,
      new GitBrowser(git, repositories, config),
      config,
    );
    search.enqueue(repository.id);
    expect(await search.processNext()).toBe(true);

    const ownerResults = search.search('widget flickers', owner.id);
    expect(ownerResults).toHaveLength(1);
    expect(ownerResults[0]).toMatchObject({
      type: 'issue',
      repository: 'private-tracker',
      url: `/owner/private-tracker/issues/${String(created.number)}`,
    });
    expect(ownerResults[0]?.title).toContain(`#${String(created.number)}`);

    expect(search.search('widget flickers', outsider.id)).toEqual([]);
    expect(search.search('widget flickers', null)).toEqual([]);
    database.close();
  });
});
