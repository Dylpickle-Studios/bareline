import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitBrowser } from '../src/git/git-browser.js';
import { GitRunner } from '../src/git/git-runner.js';
import { GroupService } from '../src/groups/group-service.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { RepositoryMutationService } from '../src/repositories/repository-mutation-service.js';
import { SearchService } from '../src/search/search-service.js';
import { temporaryConfig } from './helpers.js';

describe('local search indexing', () => {
  it('indexes Git incrementally and filters private results before returning them', async () => {
    const config = temporaryConfig();
    config.registration.mode = 'open';
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const user = await new AuthService(database, config, audit).register({
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse battery staple',
    });
    await new AuthService(database, config, audit).register({
      username: 'bob',
      displayName: 'Bob Needle',
      password: 'another correct horse password',
    });
    new GroupService(database, audit).create(user.id, 'needle-team', 'Needle Team');
    const git = new GitRunner('git', 10_000, 16 * 1024 * 1024);
    const repositories = new RepositoryService(database, git, config, audit);
    const publicRepository = await repositories.createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'public-code',
      description: 'needle <img src=x onerror=alert(1)>',
      visibility: 'public',
      initializeReadme: true,
    });
    const privateRepository = await repositories.createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'private-code',
      description: 'needle private material',
      visibility: 'private',
      initializeReadme: true,
    });
    const mutations = new RepositoryMutationService(database, git, repositories, config, audit);
    await mutations.createBranch(publicRepository, user.id, 'feature-needle', 'main');
    await mutations.commitFile({
      repository: publicRepository,
      actorUserId: user.id,
      branch: 'feature-needle',
      filePath: 'feature.txt',
      content: Buffer.from('branch-only-search-term'),
      message: 'Add feature content',
    });
    await mutations.createTag(publicRepository, user.id, 'needle-v1', 'main');
    config.search.indexedBranches = ['feature-needle'];
    const search = new SearchService(
      database,
      git,
      repositories,
      new GitBrowser(git, repositories, config),
      config,
    );
    search.enqueue(publicRepository.id);
    search.enqueue(privateRepository.id);
    expect(await search.processNext()).toBe(true);
    expect(await search.processNext()).toBe(true);
    const anonymous = search.search('needle', null);
    expect(new Set(anonymous.map((result) => result.repository))).toEqual(new Set(['public-code']));
    expect(anonymous.find((result) => result.type === 'repository')?.excerpt).not.toContain('<img');
    expect(anonymous.map((result) => result.type)).toEqual(
      expect.arrayContaining(['repository', 'branch', 'tag']),
    );
    expect(search.search('private material', null)).toEqual([]);
    const branchResult = search.search('branch-only-search-term', null)[0];
    expect(branchResult?.path).toBe('feature.txt');
    expect(branchResult?.url).toContain('ref=feature-needle');
    expect(search.search('private material', user.id).map((result) => result.repository)).toEqual([
      'private-code',
    ]);
    expect(search.searchDirectory('needle', null)).toEqual([]);
    expect(search.searchDirectory('needle', user.id).map((result) => result.type)).toEqual([
      'user',
      'group',
    ]);
    expect(search.status()).toMatchObject({ pending: 0, running: 0, failed: 0 });
    database.close();
  });
});
