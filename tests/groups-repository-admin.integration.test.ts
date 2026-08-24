import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { GroupService } from '../src/groups/group-service.js';
import { RepositoryAdminService } from '../src/repositories/repository-admin-service.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

describe('groups and repository administration', () => {
  it('enforces group roles, grants, transfer, rename, visibility, and delayed trash deletion', async () => {
    const config = temporaryConfig();
    config.registration.mode = 'open';
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const auth = new AuthService(database, config, audit);
    const alice = await auth.register({
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse battery staple',
    });
    const bob = await auth.register({
      username: 'bob',
      displayName: 'Bob',
      password: 'another correct horse password',
    });
    const groups = new GroupService(database, audit);
    const groupId = groups.create(alice.id, 'acme', 'Acme');
    groups.addMember(alice.id, groupId, 'bob', 'member');
    expect(groups.role(groupId, bob.id)).toBe('member');

    const repositories = new RepositoryService(
      database,
      new GitRunner('git', 10_000, 16 * 1024 * 1024),
      config,
      audit,
    );
    let repository = await repositories.createForUser({
      actorUserId: alice.id,
      ownerUserId: alice.id,
      slug: 'example',
      visibility: 'private',
      initializeReadme: true,
    });
    const admin = new RepositoryAdminService(database, repositories, config, audit);
    const transferredRepository = await repositories.createForUser({
      actorUserId: alice.id,
      ownerUserId: alice.id,
      slug: 'accepted-transfer',
      visibility: 'private',
      initializeReadme: true,
    });
    expect(admin.transfer(transferredRepository, alice.id, 'user', 'bob').ownerSlug).toBe('alice');
    expect(admin.pendingTransfers(bob.id)).toMatchObject([
      { repositoryId: transferredRepository.id, owner: 'alice', repository: 'accepted-transfer' },
    ]);
    expect(admin.resolveTransfer(transferredRepository.id, bob.id, true)?.ownerSlug).toBe('bob');
    const events: string[] = [];
    admin.setEventPublisher((event) => events.push(event));
    admin.setGrant(repository, alice.id, 'user', bob.id, 'write');
    expect(repositories.permission(repository, bob.id)).toBe('write');
    repository = admin.rename(repository, alice.id, 'renamed');
    repository = admin.changeVisibility(repository, alice.id, 'public');
    repository = admin.transfer(repository, alice.id, 'group', 'acme');
    expect(repository.ownerSlug).toBe('acme');
    expect(repositories.permission(repository, alice.id)).toBe('owner');
    await admin.delete(repository, alice.id);
    expect(events).toEqual([
      'repository.renamed',
      'repository.visibilityChanged',
      'repository.deleted',
    ]);
    expect(repositories.find('acme', 'renamed')).toBeNull();
    expect((await readdir(config.storage.trash)).some((name) => name.endsWith('.git'))).toBe(true);
    database
      .prepare('UPDATE repositories SET deleted_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', repository.id);
    expect(await admin.purgeExpiredTrash()).toBe(1);
    expect(await readdir(config.storage.trash)).toEqual([]);
    const auditCount = database
      .prepare("SELECT count(*) AS count FROM audit_events WHERE action LIKE 'repository.%'")
      .get() as { count: number };
    expect(auditCount.count).toBeGreaterThanOrEqual(5);
    database.close();
  });
});
