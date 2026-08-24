import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { RepositoryMutationService } from '../src/repositories/repository-mutation-service.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

describe('web commits', () => {
  it('creates and deletes files atomically without a worktree', async () => {
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
      visibility: 'private',
      initializeReadme: true,
    });
    const mutations = new RepositoryMutationService(database, git, repositories, config, audit);
    const events: string[] = [];
    mutations.setEventPublisher((event) => events.push(event));
    const created = await mutations.commitFile({
      repository,
      actorUserId: user.id,
      branch: 'main',
      filePath: 'docs/guide.md',
      content: Buffer.from('# Guide\n'),
      message: 'Add guide',
    });
    expect(created).toMatch(/^[0-9a-f]{40}$/);
    expect((await repositories.readBlob(repository, 'main', 'docs/guide.md')).toString()).toBe(
      '# Guide\n',
    );
    await mutations.commitFiles({
      repository,
      actorUserId: user.id,
      branch: 'main',
      files: [
        { path: 'assets/empty.txt', content: Buffer.alloc(0) },
        { path: 'assets/data.bin', content: Buffer.from([0, 1, 2, 3]) },
      ],
      message: 'Upload assets',
    });
    expect(await repositories.readBlob(repository, 'main', 'assets/empty.txt')).toHaveLength(0);
    expect(await repositories.readBlob(repository, 'main', 'assets/data.bin')).toEqual(
      Buffer.from([0, 1, 2, 3]),
    );
    await mutations.createBranch(repository, user.id, 'feature/docs', 'main');
    await mutations.createTag(repository, user.id, 'v1.0.0', 'main');
    expect(
      await mutations.commitFile({
        repository,
        actorUserId: user.id,
        branch: 'feature/docs',
        filePath: 'docs/guide.md',
        message: 'Remove guide',
      }),
    ).toMatch(/^[0-9a-f]{40}$/);
    await expect(
      repositories.readBlob(repository, 'feature/docs', 'docs/guide.md'),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
    await mutations.deleteBranch(repository, user.id, 'feature/docs');
    await mutations.deleteTag(repository, user.id, 'v1.0.0');
    expect(events).toEqual([
      'commit.createdViaWeb',
      'commit.createdViaWeb',
      'branch.created',
      'tag.created',
      'commit.createdViaWeb',
      'branch.deleted',
      'tag.deleted',
    ]);
    await expect(repositories.resolveCommit(repository, 'feature/docs')).rejects.toThrow();
    expect(
      database
        .prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'commit.createdViaWeb'")
        .get(),
    ).toEqual({ count: 3 });
    database.close();
  });
});
