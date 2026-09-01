import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { RepositoryMutationService } from '../src/repositories/repository-mutation-service.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

async function setup() {
  const config = temporaryConfig();
  config.registration.mode = 'open';
  const database = openDatabase(config.database.path);
  const audit = new AuditService(database);
  const auth = new AuthService(database, config, audit);
  const alice = await auth.register({
    username: 'alice',
    displayName: 'Alice',
    password: 'correct horse battery staple',
  });
  const git = new GitRunner('git', 10_000, 16 * 1024 * 1024);
  const repositories = new RepositoryService(database, git, config, audit);
  const mutations = new RepositoryMutationService(database, git, repositories, config, audit);
  return { config, database, audit, auth, alice, git, repositories, mutations };
}

describe('repository forking', () => {
  it('clones every branch and tag into a new, independently owned repository', async () => {
    const { database, auth, alice, repositories, mutations } = await setup();
    const source = await repositories.createForUser({
      actorUserId: alice.id,
      ownerUserId: alice.id,
      slug: 'origin',
      visibility: 'public',
      initializeReadme: true,
    });
    await mutations.createBranch(source, alice.id, 'feature', 'main');
    await mutations.createTag(source, alice.id, 'v1', 'main');

    const bob = await auth.register({
      username: 'bob',
      displayName: 'Bob',
      password: 'correct horse battery staple',
    });
    const fork = await repositories.fork({
      actorUserId: bob.id,
      source,
      ownerType: 'user',
      ownerId: bob.id,
      slug: 'origin',
      visibility: 'public',
    });
    expect(fork.ownerSlug).toBe('bob');
    expect(fork.forkedFromId).toBe(source.id);
    expect(repositories.countForks(source.id)).toBe(1);
    expect((await repositories.readBlob(fork, 'main', 'README.md')).toString()).toContain(
      '# origin',
    );
    expect(await repositories.resolveCommit(fork, 'feature')).toEqual(
      await repositories.resolveCommit(source, 'feature'),
    );
    expect(await repositories.resolveCommit(fork, 'v1')).toBeTruthy();

    // A private source repository cannot be forked by someone without read access.
    const private_ = await repositories.createForUser({
      actorUserId: alice.id,
      ownerUserId: alice.id,
      slug: 'secret',
      visibility: 'private',
      initializeReadme: true,
    });
    await expect(
      repositories.fork({
        actorUserId: bob.id,
        source: private_,
        ownerType: 'user',
        ownerId: bob.id,
        slug: 'secret',
        visibility: 'private',
      }),
    ).rejects.toThrow();
    database.close();
  });
});

describe('cherry-pick and revert', () => {
  it('cherry-picks a commit onto another branch and can revert it again', async () => {
    const { database, alice, repositories, mutations } = await setup();
    const repository = await repositories.createForUser({
      actorUserId: alice.id,
      ownerUserId: alice.id,
      slug: 'app',
      visibility: 'private',
      initializeReadme: true,
    });
    await mutations.createBranch(repository, alice.id, 'feature', 'main');
    const commitId = await mutations.commitFile({
      repository,
      actorUserId: alice.id,
      branch: 'feature',
      filePath: 'feature.txt',
      content: Buffer.from('new capability\n'),
      message: 'Add feature.txt',
    });

    const pickedId = await mutations.cherryPick({
      repository,
      actorUserId: alice.id,
      objectId: commitId,
      targetBranch: 'main',
    });
    expect(pickedId).toMatch(/^[0-9a-f]{40}$/);
    expect((await repositories.readBlob(repository, 'main', 'feature.txt')).toString()).toBe(
      'new capability\n',
    );

    const revertedId = await mutations.revertCommit({
      repository,
      actorUserId: alice.id,
      objectId: pickedId,
      targetBranch: 'main',
    });
    await expect(repositories.readBlob(repository, 'main', 'feature.txt')).rejects.toThrow();
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action IN ('commit.cherryPickedViaWeb', 'commit.revertedViaWeb')",
        )
        .get(),
    ).toEqual({ count: 2 });
    void revertedId;
    database.close();
  });
});

describe('branch merging', () => {
  it('fast-forwards when possible and creates a real merge commit otherwise', async () => {
    const { database, alice, repositories, mutations } = await setup();
    const repository = await repositories.createForUser({
      actorUserId: alice.id,
      ownerUserId: alice.id,
      slug: 'merges',
      visibility: 'private',
      initializeReadme: true,
    });
    await mutations.createBranch(repository, alice.id, 'feature', 'main');
    await mutations.commitFile({
      repository,
      actorUserId: alice.id,
      branch: 'feature',
      filePath: 'feature.txt',
      content: Buffer.from('a\n'),
      message: 'Add feature.txt',
    });

    // main has not diverged, so this merge is a fast-forward.
    const ffResult = await mutations.mergeBranch({
      repository,
      actorUserId: alice.id,
      sourceInput: 'feature',
      targetBranch: 'main',
    });
    expect(await repositories.resolveCommit(repository, 'main')).toBe(ffResult);
    expect((await repositories.readBlob(repository, 'main', 'feature.txt')).toString()).toBe('a\n');

    // Now diverge both branches on unrelated files so a real merge commit is required.
    await mutations.createBranch(repository, alice.id, 'feature2', 'main');
    await mutations.commitFile({
      repository,
      actorUserId: alice.id,
      branch: 'feature2',
      filePath: 'other.txt',
      content: Buffer.from('b\n'),
      message: 'Add other.txt',
    });
    await mutations.commitFile({
      repository,
      actorUserId: alice.id,
      branch: 'main',
      filePath: 'unrelated.txt',
      content: Buffer.from('c\n'),
      message: 'Add unrelated.txt',
    });
    const mergeCommit = await mutations.mergeBranch({
      repository,
      actorUserId: alice.id,
      sourceInput: 'feature2',
      targetBranch: 'main',
    });
    expect((await repositories.readBlob(repository, 'main', 'other.txt')).toString()).toBe('b\n');
    expect((await repositories.readBlob(repository, 'main', 'unrelated.txt')).toString()).toBe(
      'c\n',
    );
    expect(mergeCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(await repositories.resolveCommit(repository, 'main')).toBe(mergeCommit);
    database.close();
  });

  it('rejects a merge with real conflicts', async () => {
    const { database, alice, repositories, mutations } = await setup();
    const repository = await repositories.createForUser({
      actorUserId: alice.id,
      ownerUserId: alice.id,
      slug: 'conflicts',
      visibility: 'private',
      initializeReadme: true,
    });
    await mutations.commitFile({
      repository,
      actorUserId: alice.id,
      branch: 'main',
      filePath: 'f.txt',
      content: Buffer.from('line1\n'),
      message: 'init',
    });
    await mutations.createBranch(repository, alice.id, 'feature', 'main');
    await mutations.commitFile({
      repository,
      actorUserId: alice.id,
      branch: 'feature',
      filePath: 'f.txt',
      content: Buffer.from('line1\nfeature\n'),
      message: 'feature change',
    });
    await mutations.commitFile({
      repository,
      actorUserId: alice.id,
      branch: 'main',
      filePath: 'f.txt',
      content: Buffer.from('line1\nmain\n'),
      message: 'main change',
    });
    await expect(
      mutations.mergeBranch({
        repository,
        actorUserId: alice.id,
        sourceInput: 'feature',
        targetBranch: 'main',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    database.close();
  });
});
