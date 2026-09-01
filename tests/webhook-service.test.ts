import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { WebhookService } from '../src/webhooks/webhook-service.js';
import { temporaryConfig } from './helpers.js';

describe('webhook service', () => {
  it('encrypts one-time secrets and creates bounded repository delivery jobs', async () => {
    const config = temporaryConfig();
    config.security.masterKey = randomBytes(32).toString('base64url');
    config.webhooks.allowedHosts = ['example.com'];
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
      slug: 'hooks',
      visibility: 'private',
      initializeReadme: false,
    });
    const webhooks = new WebhookService(database, config, audit);
    const created = webhooks.create(repository.id, user.id, 'https://example.com/events', [
      'repository.created',
    ]);
    expect(created.secret).toHaveLength(43);
    expect(webhooks.list(repository.id)).toMatchObject([
      { id: created.id, url: 'https://example.com/events', events: ['repository.created'] },
    ]);
    expect(
      database
        .prepare('SELECT secret_encrypted AS secret FROM webhooks WHERE id=?')
        .get(created.id),
    ).not.toMatchObject({ secret: Buffer.from(created.secret) });
    webhooks.publish('repository.created', { repositoryId: repository.id, repository: 'hooks' });
    expect(database.prepare('SELECT count(*) AS count FROM webhook_deliveries').get()).toEqual({
      count: 1,
    });

    const issueHook = webhooks.create(repository.id, user.id, 'https://example.com/issues', [
      'issue.created',
    ]);
    webhooks.publish('issue.created', { repositoryId: repository.id, number: 1 });
    expect(
      database
        .prepare('SELECT count(*) AS count FROM webhook_deliveries WHERE webhook_id = ?')
        .get(issueHook.id),
    ).toEqual({ count: 1 });

    webhooks.remove(repository.id, user.id, created.id);
    expect(webhooks.list(repository.id)).toMatchObject([{ id: issueHook.id }]);
    database.close();
  });
});
