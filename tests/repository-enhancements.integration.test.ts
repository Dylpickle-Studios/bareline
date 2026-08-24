import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { RepositoryEnhancementService } from '../src/repositories/repository-enhancement-service.js';
import { RepositoryMutationService } from '../src/repositories/repository-mutation-service.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

describe('Git-focused repository enhancements', () => {
  it('enforces policies and stores discovery/activity state without duplicating Git data', async () => {
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
      slug: 'policy-test',
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
    await enhancements.setPolicy(repository, user.id, {
      refPattern: 'main',
      blockForcePush: true,
      blockDeletion: true,
      requireSignedCommits: false,
      commitMessagePrefix: 'TEST-',
    });
    await expect(
      mutations.commitFile({
        repository,
        actorUserId: user.id,
        branch: 'main',
        filePath: 'blocked.txt',
        content: Buffer.from('no'),
        message: 'wrong',
      }),
    ).rejects.toThrow('must start');
    await mutations.commitFile({
      repository,
      actorUserId: user.id,
      branch: 'main',
      filePath: 'allowed.txt',
      content: Buffer.from('yes'),
      message: 'TEST-add file',
    });
    enhancements.pin(user.id, repository.id, true);
    enhancements.touchRecent(user.id, repository.id);
    expect(enhancements.pinnedIds(user.id)).toEqual([repository.id]);
    expect(enhancements.recentIds(user.id)).toEqual([repository.id]);
    expect(enhancements.activity(repository.id).length).toBeGreaterThan(0);
    expect(() => {
      enhancements.configureMirror(repository, user.id, {
        direction: 'pull',
        remoteUrl: 'https://internal.example/repository.git',
        intervalMinutes: 60,
      });
    }).toThrow('not allowlisted');
    expect(
      (
        await git.run([
          '--git-dir',
          await repositories.storagePath(repository),
          'config',
          '--get',
          'receive.denyNonFastForwards',
        ])
      ).stdout
        .toString()
        .trim(),
    ).toBe('true');
    database.close();
  });
});
