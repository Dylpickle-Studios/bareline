import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app/create-app.js';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { TokenService } from '../src/auth/token-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitBrowser } from '../src/git/git-browser.js';
import { GitRunner } from '../src/git/git-runner.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

describe('Git Smart HTTP', () => {
  it('clones a public repository through git http-backend', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const auth = new AuthService(database, config, audit);
    const git = new GitRunner('git', 15_000, 16 * 1024 * 1024);
    const user = await auth.register({
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse battery staple',
    });
    const repositories = new RepositoryService(database, git, config, audit);
    await repositories.createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'public-example',
      visibility: 'public',
      initializeReadme: true,
    });
    database.close();

    const app = await createApp(config);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const destination = await mkdtemp(join(tmpdir(), 'focused-git-clone-'));
    try {
      await git.run(
        ['clone', '--', `${address}/alice/public-example.git`, join(destination, 'checkout')],
        {
          timeoutMs: 30_000,
        },
      );
      const result = await git.run(['-C', join(destination, 'checkout'), 'show', 'HEAD:README.md']);
      expect(result.stdout.toString()).toBe('# public-example\n');
    } finally {
      await app.close();
    }
  }, 30_000);

  it('authenticates a scoped token and accepts a real push', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const auth = new AuthService(database, config, audit);
    const git = new GitRunner('git', 30_000, 32 * 1024 * 1024);
    const user = await auth.register({
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse battery staple',
    });
    const repositories = new RepositoryService(database, git, config, audit);
    const repository = await repositories.createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'private-example',
      visibility: 'private',
      initializeReadme: true,
    });
    const repositoryPath = await repositories.storagePath(repository);
    const hookMarker = join(config.storage.data, 'hook-ran');
    await mkdir(join(repositoryPath, 'hooks'), { recursive: true });
    await writeFile(
      join(repositoryPath, 'hooks', 'pre-receive'),
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(hookMarker)}, 'ran');\n`,
      { mode: 0o755 },
    );
    const token = new TokenService(database).create({
      userId: user.id,
      name: 'push test',
      scopes: ['repository:read', 'repository:write'],
    });
    database.close();

    const app = await createApp(config);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const destination = await mkdtemp(join(tmpdir(), 'focused-git-push-'));
    const checkout = join(destination, 'checkout');
    const authenticatedAddress = address.replace('http://', `http://alice:${token}@`);
    try {
      await git.run(['clone', '--', `${authenticatedAddress}/alice/private-example.git`, checkout]);
      await git.run(['-C', checkout, 'config', 'user.name', 'Alice']);
      await git.run(['-C', checkout, 'config', 'user.email', 'alice@example.test']);
      await git.run(['-C', checkout, 'commit', '--allow-empty', '-m', 'Pushed over HTTPS']);
      await git.run(['-C', checkout, 'push', 'origin', 'main']);

      const verificationDatabase = openDatabase(config.database.path);
      const verificationService = new RepositoryService(
        verificationDatabase,
        git,
        config,
        new AuditService(verificationDatabase),
      );
      const commits = await new GitBrowser(git, verificationService, config).commits(
        repository,
        'main',
      );
      expect(commits[0]?.subject).toBe('Pushed over HTTPS');
      await expect(access(hookMarker)).rejects.toMatchObject({ code: 'ENOENT' });
      verificationDatabase.close();
    } finally {
      await app.close();
    }
  }, 30_000);
});
