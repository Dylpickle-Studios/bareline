import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { GitBrowser } from '../src/git/git-browser.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

describe('repository integration', () => {
  it('creates an opaque bare repository and browses a real commit', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const auth = new AuthService(database, config, audit);
    const user = await auth.register({
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse battery staple',
    });
    const service = new RepositoryService(
      database,
      new GitRunner('git', 10_000, 16 * 1024 * 1024),
      config,
      audit,
    );
    const events: string[] = [];
    service.setEventPublisher((event) => events.push(event));
    const repository = await service.createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'example',
      visibility: 'private',
      initializeReadme: true,
      gitignore: 'node',
      license: 'mit',
    });
    expect(repository.storageId).toMatch(/^[0-9a-f]{64}$/);
    expect(events).toContain('repository.created');
    expect(repository.storageId).not.toContain('alice');
    const tree = await service.listTree(repository, 'main');
    expect(tree.map((entry) => entry.name)).toEqual(['.gitignore', 'LICENSE', 'README.md']);
    expect((await service.readBlob(repository, 'main', '.gitignore')).toString()).toContain(
      'node_modules/',
    );
    expect((await service.readBlob(repository, 'main', 'LICENSE')).toString()).toContain(
      'MIT License',
    );
    expect((await service.readBlob(repository, 'main', 'README.md')).toString()).toBe(
      '# example\n',
    );
    expect(service.permission(repository, user.id)).toBe('owner');
    expect(service.permission(repository, null)).toBe('none');
    const git = new GitRunner('git', 10_000, 16 * 1024 * 1024);
    const browser = new GitBrowser(git, service, config);
    const blame = await browser.blame(repository, 'main', 'README.md');
    expect(blame).toMatchObject([{ lineNumber: 1, author: 'Bareline', content: '# example' }]);
    const comparison = await browser.compare(repository, 'main', 'main');
    expect(comparison.commits).toEqual([]);
    expect(comparison.diff).toBe('');
    const repositoryPath = await service.storagePath(repository);
    await git.run([
      '-c',
      'user.name=Alice',
      '-c',
      'user.email=alice@example.test',
      '--git-dir',
      repositoryPath,
      'tag',
      '-a',
      'v1.0.0',
      '-m',
      'Release',
      'main',
    ]);
    const tags = await browser.tags(repository);
    expect(tags).toMatchObject([
      { name: 'v1.0.0', subject: 'Release', signature: { state: 'unsigned' } },
    ]);
    expect(tags[0]?.objectId).toBe(await service.resolveCommit(repository, 'main'));
    database.close();
  });
});
