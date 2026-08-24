import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

describe('existing repository imports', () => {
  it('accepts only administrator-selected repositories inside canonical allowlisted roots', async () => {
    const config = temporaryConfig();
    config.registration.mode = 'open';
    const root = await mkdtemp(join(tmpdir(), 'git-import-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'git-import-outside-'));
    config.storage.importRoots = [root];
    const git = new GitRunner('git', 10_000, 1024 * 1024);
    await git.run(['init', '--bare', '--initial-branch', 'main', '--', join(root, 'allowed.git')]);
    await git.run([
      'init',
      '--bare',
      '--initial-branch',
      'main',
      '--',
      join(outside, 'denied.git'),
    ]);
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const auth = new AuthService(database, config, audit);
    const administrator = await auth.register({
      username: 'admin-user',
      displayName: 'Admin',
      password: 'long-enough-password',
    });
    const repositories = new RepositoryService(database, git, config, audit);
    const imported = await repositories.importExistingByOwnerName({
      actorUserId: administrator.id,
      ownerType: 'user',
      ownerSlug: administrator.username,
      slug: 'imported',
      visibility: 'private',
      sourcePath: join(root, 'allowed.git'),
    });
    expect(imported.storageKind).toBe('imported_bare');
    await expect(repositories.storagePath(imported)).resolves.toBe(join(root, 'allowed.git'));
    await expect(
      repositories.importExistingByOwnerName({
        actorUserId: administrator.id,
        ownerType: 'user',
        ownerSlug: administrator.username,
        slug: 'denied',
        visibility: 'private',
        sourcePath: join(outside, 'denied.git'),
      }),
    ).rejects.toThrow(/outside configured/);
    database.close();
  });
});
