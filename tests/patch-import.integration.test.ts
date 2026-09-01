import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { RepositoryMutationService } from '../src/repositories/repository-mutation-service.js';
import { NotFoundError, RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

/** Builds a throwaway working-tree repository and returns a `git format-patch` series. */
function buildAdditivePatchSeries(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bareline-patch-src-'));
  const run = (args: string[]): string =>
    execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'origin@example.com']);
  run(['config', 'user.name', 'Origin']);
  writeFileSync(join(directory, 'base.txt'), 'base\n');
  run(['add', 'base.txt']);
  run(['commit', '-q', '-m', 'baseline']);
  const baseline = run(['rev-parse', 'HEAD']).trim();
  writeFileSync(join(directory, 'alpha.txt'), 'alpha content\n');
  run(['add', 'alpha.txt']);
  run(['commit', '-q', '-m', 'Add alpha', '--author=Alice <alice@example.com>']);
  writeFileSync(join(directory, 'beta.txt'), 'beta content\n');
  run(['add', 'beta.txt']);
  run(['commit', '-q', '-m', 'Add beta', '--author=Bob <bob@example.com>']);
  return run(['format-patch', `${baseline}..HEAD`, '--stdout']);
}

/** Builds two sequential, context-dependent patches against a known starting file. */
function buildSequentialPatchSeries(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bareline-patch-seq-'));
  const run = (args: string[]): string =>
    execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'origin@example.com']);
  run(['config', 'user.name', 'Origin']);
  writeFileSync(join(directory, 'file.txt'), 'hello\n');
  run(['add', 'file.txt']);
  run(['commit', '-q', '-m', 'baseline']);
  const baseline = run(['rev-parse', 'HEAD']).trim();
  writeFileSync(join(directory, 'file.txt'), 'hello\nworld\n');
  run(['add', 'file.txt']);
  run(['commit', '-q', '-m', 'Add world line']);
  writeFileSync(join(directory, 'file.txt'), 'hello\nworld\nagain\n');
  run(['add', 'file.txt']);
  run(['commit', '-q', '-m', 'Add again line']);
  return run(['format-patch', `${baseline}..HEAD`, '--stdout']);
}

async function setup() {
  const config = temporaryConfig();
  config.registration.mode = 'open';
  const database = openDatabase(config.database.path);
  const audit = new AuditService(database);
  const auth = new AuthService(database, config, audit);
  const user = await auth.register({
    username: 'importer',
    displayName: 'Importer',
    password: 'correct horse battery staple',
  });
  const git = new GitRunner('git', 10_000, 16 * 1024 * 1024);
  const repositories = new RepositoryService(database, git, config, audit);
  const mutations = new RepositoryMutationService(database, git, repositories, config, audit);
  return { config, database, audit, auth, user, git, repositories, mutations };
}

describe('patch import', () => {
  it('imports a multi-commit format-patch series, preserving original authorship', async () => {
    const { database, user, repositories, mutations } = await setup();
    const repository = await repositories.createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'example',
      visibility: 'private',
      initializeReadme: true,
    });
    const events: string[] = [];
    mutations.setEventPublisher((event) => events.push(event));
    const series = buildAdditivePatchSeries();

    const preview = await mutations.previewPatch({
      repository,
      actorUserId: user.id,
      branch: 'main',
      patchContent: Buffer.from(series, 'utf8'),
    });
    expect(preview.valid).toBe(true);
    expect(preview.commits).toHaveLength(2);
    expect(preview.commits[0]?.subject).toBe('Add alpha');
    expect(preview.commits[0]?.authorName).toBe('Alice');
    expect(preview.commits[1]?.subject).toBe('Add beta');

    const commitId = await mutations.importPatch({
      repository,
      actorUserId: user.id,
      branch: 'main',
      patchContent: Buffer.from(series, 'utf8'),
    });
    expect(commitId).toMatch(/^[0-9a-f]{40}$/);
    expect((await repositories.readBlob(repository, 'main', 'alpha.txt')).toString()).toBe(
      'alpha content\n',
    );
    expect((await repositories.readBlob(repository, 'main', 'beta.txt')).toString()).toBe(
      'beta content\n',
    );
    // Pre-existing content from the target branch must survive an additive import.
    expect(await repositories.readBlob(repository, 'main', 'README.md')).toBeInstanceOf(Buffer);
    expect(await repositories.resolveCommit(repository, 'main')).toBe(commitId);

    const path = await repositories.storagePath(repository);
    const secondParentLog = execFileSync(
      'git',
      ['--git-dir', path, 'log', '--format=%an <%ae> | %cn <%ce>', `${commitId}~1..${commitId}`],
      { encoding: 'utf8' },
    ).trim();
    expect(secondParentLog).toBe('Bob <bob@example.com> | Importer <importer@users.noreply.local>');
    const firstParentLog = execFileSync(
      'git',
      ['--git-dir', path, 'log', '--format=%an <%ae>', `${commitId}~2..${commitId}~1`],
      { encoding: 'utf8' },
    ).trim();
    expect(firstParentLog).toBe('Alice <alice@example.com>');

    expect(events).toEqual(['patch.importedViaWeb']);
    expect(
      database
        .prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'patch.importedViaWeb'")
        .get(),
    ).toEqual({ count: 1 });
    database.close();
  });

  it('applies sequential context-dependent patches with full tree fidelity', async () => {
    const { database, user, repositories, mutations } = await setup();
    const repository = await repositories.createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'sequential',
      visibility: 'private',
      initializeReadme: true,
    });
    await mutations.commitFile({
      repository,
      actorUserId: user.id,
      branch: 'main',
      filePath: 'file.txt',
      content: Buffer.from('hello\n'),
      message: 'baseline',
    });
    const series = buildSequentialPatchSeries();

    const commitId = await mutations.importPatch({
      repository,
      actorUserId: user.id,
      branch: 'main',
      patchContent: Buffer.from(series, 'utf8'),
    });
    expect((await repositories.readBlob(repository, 'main', 'file.txt')).toString()).toBe(
      'hello\nworld\nagain\n',
    );
    void commitId;
    database.close();
  });

  it('reports a failing patch during preview without moving the branch', async () => {
    const { database, user, repositories, mutations } = await setup();
    const repository = await repositories.createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'conflict',
      visibility: 'private',
      initializeReadme: true,
    });
    const tipBefore = await repositories.resolveCommit(repository, 'main');
    const patch = Buffer.from(
      [
        'diff --git a/missing.txt b/missing.txt',
        'index 0000000..1111111 100644',
        '--- a/missing.txt',
        '+++ b/missing.txt',
        '@@ -1 +1,2 @@',
        ' existing line',
        '+new line',
        '',
      ].join('\n'),
      'utf8',
    );
    const preview = await mutations.previewPatch({
      repository,
      actorUserId: user.id,
      branch: 'main',
      patchContent: patch,
    });
    expect(preview.valid).toBe(false);
    expect(preview.commits[0]?.applied).toBe(false);
    expect(preview.commits[0]?.error).toBeTruthy();
    expect(await repositories.resolveCommit(repository, 'main')).toBe(tipBefore);

    await expect(
      mutations.importPatch({
        repository,
        actorUserId: user.id,
        branch: 'main',
        patchContent: patch,
        fallbackMessage: 'Attempted import',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await repositories.resolveCommit(repository, 'main')).toBe(tipBefore);
    database.close();
  });

  it('rejects a raw diff with no fallback commit message', async () => {
    const { database, user, repositories, mutations } = await setup();
    const repository = await repositories.createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'rawdiff',
      visibility: 'private',
      initializeReadme: true,
    });
    const rawDiff = Buffer.from(
      [
        'diff --git a/new-file.txt b/new-file.txt',
        'new file mode 100644',
        'index 0000000..3b18e51',
        '--- /dev/null',
        '+++ b/new-file.txt',
        '@@ -0,0 +1 @@',
        '+hello there',
        '',
      ].join('\n'),
      'utf8',
    );
    await expect(
      mutations.importPatch({
        repository,
        actorUserId: user.id,
        branch: 'main',
        patchContent: rawDiff,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    const commitId = await mutations.importPatch({
      repository,
      actorUserId: user.id,
      branch: 'main',
      patchContent: rawDiff,
      fallbackMessage: 'Add new-file.txt',
    });
    expect((await repositories.readBlob(repository, 'main', 'new-file.txt')).toString()).toBe(
      'hello there\n',
    );
    void commitId;
    database.close();
  });

  it('rejects garbage input that contains no recognizable patch content', async () => {
    const { database, user, repositories, mutations } = await setup();
    const repository = await repositories.createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'garbage',
      visibility: 'private',
      initializeReadme: true,
    });
    await expect(
      mutations.importPatch({
        repository,
        actorUserId: user.id,
        branch: 'main',
        patchContent: Buffer.from('this is not a patch at all\njust text\n', 'utf8'),
        fallbackMessage: 'Should not be created',
      }),
    ).rejects.toThrow();
    database.close();
  });

  it('denies patch preview and import to users without write access', async () => {
    const { database, user, repositories, mutations, auth } = await setup();
    const repository = await repositories.createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'private-repo',
      visibility: 'private',
      initializeReadme: true,
    });
    const outsider = await auth.register({
      username: 'outsider',
      displayName: 'Outsider',
      password: 'correct horse battery staple',
    });
    const series = buildAdditivePatchSeries();
    await expect(
      mutations.previewPatch({
        repository,
        actorUserId: outsider.id,
        branch: 'main',
        patchContent: Buffer.from(series, 'utf8'),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      mutations.importPatch({
        repository,
        actorUserId: outsider.id,
        branch: 'main',
        patchContent: Buffer.from(series, 'utf8'),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    database.close();
  });

  it('rejects a patch that exceeds the configured size limit', async () => {
    const { database, user, repositories, mutations, config } = await setup();
    const repository = await repositories.createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'toobig',
      visibility: 'private',
      initializeReadme: true,
    });
    const oversized = Buffer.alloc(config.limits.requestBodyBytes + 1, 0x41);
    await expect(
      mutations.importPatch({
        repository,
        actorUserId: user.id,
        branch: 'main',
        patchContent: oversized,
        fallbackMessage: 'Too big',
      }),
    ).rejects.toMatchObject({ statusCode: 413 });
    database.close();
  });
});
