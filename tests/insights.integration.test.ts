import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitBrowser } from '../src/git/git-browser.js';
import { GitRunner } from '../src/git/git-runner.js';
import { computeLanguageStats, languageForPath } from '../src/git/language-stats.js';
import { RepositoryMutationService } from '../src/repositories/repository-mutation-service.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

describe('language detection', () => {
  it('maps common extensions to languages and weighs stats by byte size', () => {
    expect(languageForPath('src/app.ts')).toBe('TypeScript');
    expect(languageForPath('README.md')).toBe('Markdown');
    expect(languageForPath('Dockerfile')).toBe('Dockerfile');
    expect(languageForPath('LICENSE')).toBeNull();
    const stats = computeLanguageStats([
      { path: 'a.ts', size: 300 },
      { path: 'b.ts', size: 100 },
      { path: 'c.py', size: 100 },
      { path: 'd.bin', size: 500 },
    ]);
    expect(stats).toEqual([
      { language: 'TypeScript', bytes: 400, percent: 80 },
      { language: 'Python', bytes: 100, percent: 20 },
    ]);
  });
});

describe('repository insights', () => {
  it('reports per-language byte stats and per-author commit counts from real Git data', async () => {
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
    const browser = new GitBrowser(git, repositories, config);
    const mutations = new RepositoryMutationService(database, git, repositories, config, audit);
    const repository = await repositories.createForUser({
      actorUserId: alice.id,
      ownerUserId: alice.id,
      slug: 'app',
      visibility: 'private',
      initializeReadme: true,
    });
    await mutations.commitFiles({
      repository,
      actorUserId: alice.id,
      branch: 'main',
      files: [
        { path: 'src/index.ts', content: Buffer.from('export const x = 1;\n') },
        { path: 'src/util.ts', content: Buffer.from('export const y = 2;\n') },
        { path: 'scripts/run.py', content: Buffer.from('print("hi")\n') },
      ],
      message: 'Add source files',
    });
    await mutations.commitFile({
      repository,
      actorUserId: alice.id,
      branch: 'main',
      filePath: 'src/index.ts',
      content: Buffer.from('export const x = 12345;\n'),
      message: 'Tweak index.ts',
    });

    const languages = await browser.languageStats(repository, 'main');
    const names = languages.map((stat) => stat.language);
    expect(names).toContain('TypeScript');
    expect(names).toContain('Python');
    expect(names).toContain('Markdown');
    const total = languages.reduce((sum, stat) => sum + stat.percent, 0);
    expect(total).toBeGreaterThan(99);
    expect(total).toBeLessThan(101);

    const contributors = await browser.contributors(repository, 'main');
    expect(contributors).toContainEqual(
      expect.objectContaining({ name: 'Alice', email: 'alice@users.noreply.local', commits: 2 }),
    );
    database.close();
  });
});
