import { rm } from 'node:fs/promises';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { GitBrowser } from '../src/git/git-browser.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { RepositoryMutationService } from '../src/repositories/repository-mutation-service.js';
import { RepositoryEnhancementService } from '../src/repositories/repository-enhancement-service.js';
import { RepositoryAdminService } from '../src/repositories/repository-admin-service.js';
import { IssueService } from '../src/repositories/issue-service.js';
import { ReleaseService } from '../src/repositories/release-service.js';
import { WikiService } from '../src/repositories/wiki-service.js';
import { SearchService } from '../src/search/search-service.js';
import { temporaryConfig } from './helpers.js';

export async function auditFixture() {
  const config = temporaryConfig();
  config.security.masterKey = Buffer.alloc(32, 7).toString('base64url');
  const database = openDatabase(config.database.path);
  const audit = new AuditService(database);
  const auth = new AuthService(database, config, audit);
  const user = auth.loginExternal({
    providerId: 'test',
    subject: 'alice',
    username: 'alice',
    displayName: 'Alice',
    autoCreate: true,
    profile: {},
  });
  const other = auth.loginExternal({
    providerId: 'test',
    subject: 'bob',
    username: 'bob',
    displayName: 'Bob',
    autoCreate: true,
    profile: {},
  });
  const git = new GitRunner('git', 10000, 16 * 1024 * 1024);
  const repositories = new RepositoryService(database, git, config, audit);
  const repository = await repositories.createForUser({
    actorUserId: user.id,
    ownerUserId: user.id,
    slug: 'audit',
    visibility: 'private',
    initializeReadme: true,
  });
  const enhancements = new RepositoryEnhancementService(database, git, repositories, audit);
  const mutations = new RepositoryMutationService(
    database,
    git,
    repositories,
    config,
    audit,
    enhancements,
  );
  const issues = new IssueService(database, repositories, enhancements, audit);
  const releases = new ReleaseService(database, repositories, mutations, config, audit);
  const wikis = new WikiService(git, repositories, config);
  const search = new SearchService(
    database,
    git,
    repositories,
    new GitBrowser(git, repositories, config),
    config,
  );
  const admin = new RepositoryAdminService(database, repositories, config, audit);
  return {
    config,
    database,
    audit,
    auth,
    user,
    other,
    git,
    repositories,
    repository,
    enhancements,
    mutations,
    issues,
    releases,
    wikis,
    search,
    admin,
    cleanup: async () => {
      if (database.open) database.close();
      await rm(config.storage.data, { recursive: true, force: true });
    },
  };
}
