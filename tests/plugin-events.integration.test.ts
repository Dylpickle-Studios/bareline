import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { PluginContributionService } from '../src/plugins/contribution-service.js';
import { PluginEventService } from '../src/plugins/event-service.js';
import { PluginManager } from '../src/plugins/plugin-manager.js';
import { SandboxRuntime } from '../src/plugins/sandbox-runtime.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

describe('plugin event delivery', () => {
  it('queues filtered events and processes them outside the publisher path', async () => {
    const config = temporaryConfig();
    config.security.masterKey = Buffer.alloc(32, 8).toString('base64url');
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
    const plugins = new PluginManager(database, config, audit);
    await plugins.installLocal(user.id, resolve('plugins/example'), { trustedRiskAccepted: true });
    plugins.setPermission(user.id, 'example.word-count', 'events.subscribe', true);
    plugins.setEnabled(user.id, 'example.word-count', true, true);
    const contributions = new PluginContributionService(
      plugins,
      new SandboxRuntime(database),
      repositories,
    );
    const events = new PluginEventService(database, plugins, contributions);

    expect(
      events.publish('repository.pushed', {
        repositoryId: 42,
        owner: 'secret-owner',
        repository: 'secret-repository',
        visibility: 'private',
      }),
    ).toBe(1);
    const queued = database
      .prepare('SELECT state, payload_json AS payload FROM plugin_event_jobs')
      .get() as { state: string; payload: string };
    expect(queued.state).toBe('pending');
    expect(JSON.parse(queued.payload)).toEqual({});
    await expect(events.processNext()).resolves.toBe(true);
    expect(database.prepare('SELECT count(*) AS count FROM plugin_event_jobs').get()).toEqual({
      count: 0,
    });
    database.close();
  });
});
