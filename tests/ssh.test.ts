import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { RepositoryEnhancementService } from '../src/repositories/repository-enhancement-service.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import {
  authorizeSshCommand,
  authorizedKeys,
  executeSshCommand,
} from '../src/ssh/forced-command.js';
import { temporaryConfig } from './helpers.js';

describe('OpenSSH forced command', () => {
  it('allows only exact Git operations against an authorized logical repository', async () => {
    const config = temporaryConfig();
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
    });
    const key = database
      .prepare(
        `
        INSERT INTO ssh_keys(user_id, name, fingerprint, public_key, created_at)
        VALUES (?, 'laptop', 'SHA256:test', 'ssh-ed25519 AAAATEST alice', ?)
      `,
      )
      .run(user.id, new Date().toISOString());
    const allowed = await authorizeSshCommand(
      database,
      repositories,
      Number(key.lastInsertRowid),
      "git-receive-pack 'alice/example.git'",
    );
    expect(allowed.operation).toBe('git-receive-pack');
    const enhancements = new RepositoryEnhancementService(
      database,
      new GitRunner('git', 10_000, 16 * 1024 * 1024),
      repositories,
      audit,
    );
    enhancements.setArchived(repository, user.id, true);
    await expect(
      authorizeSshCommand(
        database,
        repositories,
        Number(key.lastInsertRowid),
        "git-receive-pack 'alice/example.git'",
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      authorizeSshCommand(
        database,
        repositories,
        Number(key.lastInsertRowid),
        "git-upload-pack 'alice/example.git'; id",
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(
      authorizedKeys(database, '/opt/bareline/bin/bareline', '/etc/bareline/config.yml'),
    ).toContain('restrict,command=');
    config.ssh.enabled = false;
    await expect(executeSshCommand(config, allowed)).rejects.toMatchObject({ statusCode: 403 });
    database.close();
  });
});
