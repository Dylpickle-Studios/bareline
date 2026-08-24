import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { createApp } from '../src/app/create-app.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

describe('public user profiles', () => {
  it('shows public repositories without disclosing private repositories or private email', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const auth = new AuthService(database, config, audit);
    const user = await auth.register({
      username: 'alice',
      displayName: 'Alice',
      email: 'alice@example.test',
      password: 'correct horse battery staple',
    });
    const repositories = new RepositoryService(
      database,
      new GitRunner('git', 10_000, 16 * 1024 * 1024),
      config,
      audit,
    );
    for (const [slug, visibility] of [
      ['visible', 'public'],
      ['secret', 'private'],
    ] as const)
      await repositories.createForUser({
        actorUserId: user.id,
        ownerUserId: user.id,
        slug,
        visibility,
        initializeReadme: true,
      });
    database.close();
    const app = await createApp(config);
    try {
      const response = await app.inject({ method: 'GET', url: '/users/alice' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('visible');
      expect(response.body).not.toContain('secret');
      expect(response.body).not.toContain('alice@example.test');
    } finally {
      await app.close();
    }
  });
});
