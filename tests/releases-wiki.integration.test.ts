import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { ReleaseService } from '../src/repositories/release-service.js';
import { RepositoryMutationService } from '../src/repositories/repository-mutation-service.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { WikiService } from '../src/repositories/wiki-service.js';
import { temporaryConfig } from './helpers.js';

async function setup() {
  const config = temporaryConfig();
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
  const releases = new ReleaseService(database, repositories, mutations, config, audit);
  const wikis = new WikiService(git, repositories, config);
  return { config, database, alice, repositories, mutations, releases, wikis };
}

describe('releases', () => {
  it('creates a tag-backed release, uploads and downloads an asset, then deletes it', async () => {
    const { database, alice, repositories, releases } = await setup();
    const repository = await repositories.createForUser({
      actorUserId: alice.id,
      ownerUserId: alice.id,
      slug: 'app',
      visibility: 'private',
      initializeReadme: true,
    });
    const release = await releases.create({
      repository,
      actorUserId: alice.id,
      tagName: 'v1.0.0',
      name: 'First release',
      body: '## Highlights\nInitial release.',
    });
    expect(release.objectId).toMatch(/^[0-9a-f]{40}$/);
    expect(await repositories.resolveCommit(repository, 'v1.0.0')).toBe(release.objectId);
    expect(releases.list(repository.id)).toHaveLength(1);

    await expect(
      releases.create({
        repository,
        actorUserId: alice.id,
        tagName: 'v1.0.0',
        name: 'Duplicate',
        body: '',
      }),
    ).rejects.toThrow();

    const asset = await releases.addAsset({
      repository,
      actorUserId: alice.id,
      tagName: 'v1.0.0',
      filename: 'bundle.tar.gz',
      contentType: 'application/gzip',
      content: Buffer.from('binary-ish content'),
    });
    const fetched = await releases.readAsset(repository, asset.id);
    expect(fetched.content.toString()).toBe('binary-ish content');
    expect(fetched.filename).toBe('bundle.tar.gz');
    expect(releases.get(repository.id, 'v1.0.0')?.assets).toHaveLength(1);

    await releases.delete(repository, alice.id, 'v1.0.0');
    expect(releases.get(repository.id, 'v1.0.0')).toBeNull();
    await expect(releases.readAsset(repository, asset.id)).rejects.toThrow();
    database.close();
  });
});

describe('wiki', () => {
  it('creates, edits, and deletes pages in a per-repository wiki repo', async () => {
    const { database, alice, repositories, wikis } = await setup();
    const repository = await repositories.createForUser({
      actorUserId: alice.id,
      ownerUserId: alice.id,
      slug: 'app',
      visibility: 'private',
      initializeReadme: true,
    });
    expect(await wikis.exists(repository)).toBe(false);
    expect(await wikis.readPage(repository, 'Home')).toBeNull();

    await wikis.writePage({
      repository,
      actorUserId: alice.id,
      page: 'Home',
      content: '# Welcome\n',
      message: 'Create Home',
    });
    expect(await wikis.exists(repository)).toBe(true);
    expect(await wikis.readPage(repository, 'Home')).toBe('# Welcome\n');
    expect(await wikis.listPages(repository)).toEqual([expect.objectContaining({ name: 'Home' })]);

    await wikis.writePage({
      repository,
      actorUserId: alice.id,
      page: 'Home',
      content: '# Welcome again\n',
      message: 'Update Home',
    });
    expect(await wikis.readPage(repository, 'Home')).toBe('# Welcome again\n');
    const history = await wikis.history(repository, 'Home');
    expect(history).toHaveLength(2);
    expect(history[0]?.subject).toBe('Update Home');

    await wikis.writePage({
      repository,
      actorUserId: alice.id,
      page: 'Setup',
      content: '# Setup guide\n',
      message: 'Create Setup',
    });
    expect((await wikis.listPages(repository)).map((page) => page.name).sort()).toEqual([
      'Home',
      'Setup',
    ]);

    await wikis.deletePage({
      repository,
      actorUserId: alice.id,
      page: 'Setup',
      message: 'Remove Setup',
    });
    expect(await wikis.readPage(repository, 'Setup')).toBeNull();
    database.close();
  });
});
