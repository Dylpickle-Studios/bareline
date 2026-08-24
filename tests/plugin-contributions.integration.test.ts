import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { PluginContributionService } from '../src/plugins/contribution-service.js';
import { PluginManager, PluginPermissionError } from '../src/plugins/plugin-manager.js';
import { SandboxRuntime } from '../src/plugins/sandbox-runtime.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

describe('checked plugin contributions', () => {
  it('hides denied contributions and dispatches trusted tabs and commands through bounded host APIs', async () => {
    const config = temporaryConfig();
    config.security.masterKey = Buffer.alloc(32, 7).toString('base64url');
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const user = await new AuthService(database, config, audit).register({
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse battery staple',
    });
    const repositories = new RepositoryService(
      database,
      new GitRunner('git', 10_000, 16 * 1024 * 1024),
      config,
      audit,
    );
    const repository = await repositories.createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'example',
      visibility: 'private',
      initializeReadme: true,
    });
    const plugins = new PluginManager(database, config, audit);
    await plugins.installLocal(user.id, resolve('plugins/example'), { trustedRiskAccepted: true });
    plugins.setEnabled(user.id, 'example.word-count', true, true);
    const contributions = new PluginContributionService(
      plugins,
      new SandboxRuntime(database),
      repositories,
    );
    expect(contributions.repositoryTabs(repository, user.id)).toEqual([]);
    expect(contributions.fileRenderers(repository, user.id, 'README.md')).toEqual([]);
    expect(contributions.adminPages()).toEqual([]);
    expect(() => plugins.storageGet('example.word-count', 'last-result')).toThrow(
      PluginPermissionError,
    );

    for (const capability of [
      'repositoryContents.read',
      'ui.repository',
      'ui.global',
      'storage.plugin',
      'settings.read',
    ])
      plugins.setPermission(user.id, 'example.word-count', capability, true);
    plugins.setEnabled(user.id, 'example.word-count', true, true);

    expect(contributions.repositoryTabs(repository, user.id)).toMatchObject([
      { pluginId: 'example.word-count', id: 'word-count', title: 'Word Count' },
    ]);
    expect(contributions.navigation()).toEqual([
      expect.objectContaining({ id: 'word-count.docs', href: '/docs/plugins' }),
    ]);
    expect(contributions.fileRenderers(repository, user.id, 'README.md')).toEqual([
      expect.objectContaining({ id: 'word-count.preview', title: 'Word-count preview' }),
    ]);
    await expect(
      contributions.renderFile(
        repository,
        user.id,
        'example.word-count',
        'word-count.preview',
        'main',
        'README.md',
        Buffer.from('# example\n'),
      ),
    ).resolves.toMatchObject({ blocks: [{ type: 'metric', label: 'Words', value: 2 }] });
    await expect(
      contributions.transformMarkdown(
        repository,
        user.id,
        'main',
        'README.md',
        '# Example\n\n:word-count:',
      ),
    ).resolves.toContain('**Word count enabled**');
    expect(contributions.adminPages()).toEqual([
      expect.objectContaining({ id: 'word-count.status', title: 'Word Count status' }),
    ]);
    await expect(
      contributions.renderAdminPage('example.word-count', 'word-count.status', user),
    ).resolves.toMatchObject({ title: 'Repository Word Count status' });
    expect(contributions.theme('example.word-count:ink')).toMatchObject({
      title: 'Ink',
      colorScheme: 'dark',
      colors: { accent: '#67c7a5' },
    });
    const view = await contributions.renderRepositoryTab(
      repository,
      user.id,
      'example.word-count',
      'word-count',
    );
    expect(view.blocks).toEqual(
      expect.arrayContaining([
        { type: 'metric', label: 'Text files', value: 1 },
        { type: 'metric', label: 'Words', value: 2 },
      ]),
    );
    expect(plugins.storageGet('example.word-count', 'last-result')).not.toBeNull();
    await expect(
      contributions.runCommand('example.word-count', 'word-count.calculate', {
        id: user.id,
        username: user.username,
      }),
    ).resolves.toMatchObject({ title: 'Repository word count' });
    await expect(
      contributions.searchProviders('word count', { id: user.id, username: user.username }),
    ).resolves.toEqual([
      {
        title: 'Repository Word Count',
        subtitle: 'Repository Word Count · Plugin documentation',
        url: '/docs/plugins',
      },
    ]);
    await expect(
      contributions.runRestEndpoint('example.word-count', 'word-count.last-result', 'GET', {
        user: { id: String(user.id), username: user.username },
        body: null,
      }),
    ).resolves.toEqual({ files: 1, words: 2 });
    database.close();
  });
});
