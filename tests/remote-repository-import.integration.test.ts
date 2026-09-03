import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { createApp } from '../src/app/create-app.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner, type GitResult, type GitRunOptions } from '../src/git/git-runner.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { OutboundPolicy } from '../src/security/outbound-policy.js';
import { temporaryConfig } from './helpers.js';

class LocalRemoteGitRunner extends GitRunner {
  constructor(private readonly source: string) {
    super('git', 10_000, 16 * 1024 * 1024);
  }

  override async run(
    arguments_: readonly string[],
    options: GitRunOptions = {},
  ): Promise<GitResult> {
    if (arguments_.includes('ls-remote')) {
      return {
        stdout: Buffer.from(
          'ref: refs/heads/main\tHEAD\n' +
            '0123456789012345678901234567890123456789\tHEAD\n' +
            '0123456789012345678901234567890123456789\trefs/heads/main\n' +
            '0123456789012345678901234567890123456789\trefs/tags/v1.0.0\n',
        ),
        stderr: '',
        exitCode: 0,
        truncated: false,
      };
    }
    if (arguments_.includes('clone')) {
      const destination = arguments_.at(-1);
      if (!destination) throw new Error('Missing clone destination');
      return await super.run(
        ['-c', 'protocol.file.allow=always', 'clone', '--mirror', '--', this.source, destination],
        options,
      );
    }
    return await super.run(arguments_, options);
  }
}

async function sourceRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bareline-remote-source-'));
  const source = join(root, 'source.git');
  const git = new GitRunner('git', 10_000, 1024 * 1024);
  await git.run(['init', '--bare', '--initial-branch', 'main', '--', source]);
  const tree = await git.run(['--git-dir', source, 'mktree'], { input: Buffer.alloc(0) });
  const commit = await git.run(
    [
      '-c',
      'user.name=Bareline test',
      '-c',
      'user.email=test@example.invalid',
      '--git-dir',
      source,
      'commit-tree',
      tree.stdout.toString('ascii').trim(),
    ],
    { input: Buffer.from('Initial commit\n') },
  );
  const objectId = commit.stdout.toString('ascii').trim();
  await git.run(['--git-dir', source, 'update-ref', 'refs/heads/main', objectId]);
  await git.run(['--git-dir', source, 'update-ref', 'refs/tags/v1.0.0', objectId]);
  return source;
}

function publicResolver(): OutboundPolicy {
  return new OutboundPolicy(() => Promise.resolve([{ address: '93.184.216.34', family: 4 }]));
}

describe('remote repository imports', () => {
  it('exposes an administrator-only preview form and reports policy failures safely', async () => {
    const config = temporaryConfig();
    config.registration.mode = 'open';
    config.mirrors = {
      allowedHosts: ['git.example'],
      timeoutMs: 10_000,
      importTimeoutMs: 30_000,
      maxImportBytes: 16 * 1024 * 1024,
      maxImportRefs: 100,
    };
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const auth = new AuthService(database, config, audit);
    const administrator = await auth.register({
      username: 'admin-user',
      displayName: 'Admin',
      password: 'long-enough-password',
    });
    const session = auth.createSession(administrator.id);
    database.close();

    const app = await createApp(config);
    const headers = { cookie: `session=${session.token}` };
    try {
      const page = await app.inject({ method: 'GET', url: '/admin/repositories', headers });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('Import from another Git host');
      expect(page.body).toContain('/admin/repositories/import-remote/preview');

      const rejected = await app.inject({
        method: 'POST',
        url: '/admin/repositories/import-remote/preview',
        headers,
        payload: {
          csrf: session.csrfToken,
          sourceUrl: 'https://untrusted.example/team/project.git',
          ownerType: 'user',
          ownerSlug: administrator.username,
          slug: 'remote-project',
          visibility: 'private',
        },
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.body).toContain('Outbound host is not allowlisted');
      expect(rejected.body).not.toContain('OutboundPolicyError');
    } finally {
      await app.close();
    }
  });

  it('previews and imports all refs into managed storage with an audit record', async () => {
    const config = temporaryConfig();
    config.registration.mode = 'open';
    config.mirrors = {
      allowedHosts: ['git.example'],
      timeoutMs: 10_000,
      importTimeoutMs: 30_000,
      maxImportBytes: 16 * 1024 * 1024,
      maxImportRefs: 100,
    };
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const auth = new AuthService(database, config, audit);
    const administrator = await auth.register({
      username: 'admin-user',
      displayName: 'Admin',
      password: 'long-enough-password',
    });
    const git = new LocalRemoteGitRunner(await sourceRepository());
    const repositories = new RepositoryService(database, git, config, audit, publicResolver());

    await expect(
      repositories.previewRemoteImport({
        actorUserId: administrator.id,
        ownerType: 'user',
        ownerSlug: administrator.username,
        slug: 'imported-remote',
        sourceUrl: 'https://git.example/team/project.git',
      }),
    ).resolves.toEqual({
      sourceHost: 'git.example',
      defaultBranch: 'main',
      branches: 1,
      tags: 1,
      refs: 2,
    });

    const imported = await repositories.importRemoteByOwnerName({
      actorUserId: administrator.id,
      ownerType: 'user',
      ownerSlug: administrator.username,
      slug: 'imported-remote',
      description: 'Imported safely',
      visibility: 'private',
      sourceUrl: 'https://git.example/team/project.git',
    });
    expect(imported.storageKind).toBe('hosted_bare');
    expect(imported.defaultBranch).toBe('main');
    const path = await repositories.storagePath(imported);
    const refs = await git.run(['--git-dir', path, 'for-each-ref', '--format=%(refname)']);
    expect(refs.stdout.toString('utf8')).toContain('refs/heads/main');
    expect(refs.stdout.toString('utf8')).toContain('refs/tags/v1.0.0');
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action='repository.remoteImported'",
        )
        .get(),
    ).toEqual({ count: 1 });
    database.close();
  });

  it('rejects non-allowlisted and credential-bearing sources before invoking Git', async () => {
    const config = temporaryConfig();
    config.registration.mode = 'open';
    config.mirrors = {
      allowedHosts: ['git.example'],
      timeoutMs: 10_000,
      importTimeoutMs: 30_000,
      maxImportBytes: 16 * 1024 * 1024,
      maxImportRefs: 100,
    };
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const auth = new AuthService(database, config, audit);
    const administrator = await auth.register({
      username: 'admin-user',
      displayName: 'Admin',
      password: 'long-enough-password',
    });
    const repositories = new RepositoryService(
      database,
      new LocalRemoteGitRunner(await sourceRepository()),
      config,
      audit,
      publicResolver(),
    );
    await expect(
      repositories.previewRemoteImport({
        actorUserId: administrator.id,
        ownerType: 'user',
        ownerSlug: administrator.username,
        slug: 'untrusted',
        sourceUrl: 'https://untrusted.example/team/project.git',
      }),
    ).rejects.toThrow(/allowlisted/);
    await expect(
      repositories.previewRemoteImport({
        actorUserId: administrator.id,
        ownerType: 'user',
        ownerSlug: administrator.username,
        slug: 'credentialed',
        sourceUrl: 'https://token@git.example/team/project.git',
      }),
    ).rejects.toThrow(/credentials/);
    await expect(
      repositories.previewRemoteImport({
        actorUserId: administrator.id,
        ownerType: 'user',
        ownerSlug: administrator.username,
        slug: 'query-secret',
        sourceUrl: 'https://git.example/team/project.git?token=secret',
      }),
    ).rejects.toThrow(/query or fragment/);
    database.close();
  });

  it('removes partial managed state when a post-clone limit fails', async () => {
    const config = temporaryConfig();
    config.registration.mode = 'open';
    config.mirrors = {
      allowedHosts: ['git.example'],
      timeoutMs: 10_000,
      importTimeoutMs: 30_000,
      maxImportBytes: 1,
      maxImportRefs: 100,
    };
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const auth = new AuthService(database, config, audit);
    const administrator = await auth.register({
      username: 'admin-user',
      displayName: 'Admin',
      password: 'long-enough-password',
    });
    const repositories = new RepositoryService(
      database,
      new LocalRemoteGitRunner(await sourceRepository()),
      config,
      audit,
      publicResolver(),
    );
    await expect(
      repositories.importRemoteByOwnerName({
        actorUserId: administrator.id,
        ownerType: 'user',
        ownerSlug: administrator.username,
        slug: 'too-large',
        visibility: 'private',
        sourceUrl: 'https://git.example/team/project.git',
      }),
    ).rejects.toThrow(/configured import size/);
    expect(database.prepare('SELECT count(*) AS count FROM repositories').get()).toEqual({
      count: 0,
    });
    database.close();
  });
});
