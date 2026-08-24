import { lstat, mkdir, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { AuditService } from '../audit/audit-service.js';
import type { AppConfig } from '../config/config.js';
import type { Database } from '../database/database.js';
import { validateSlug } from '../security/validation.js';
import { validateRef } from '../security/validation.js';
import type { RepositoryService } from './repository-service.js';
import type {
  Permission,
  Repository,
  RepositoryEventPublisher,
  Visibility,
} from './repository-types.js';

export class RepositoryAdminService {
  private publishEvent: RepositoryEventPublisher = () => undefined;

  constructor(
    private readonly database: Database,
    private readonly repositories: RepositoryService,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  setEventPublisher(publisher: RepositoryEventPublisher): void {
    this.publishEvent = publisher;
  }

  rename(repository: Repository, actorUserId: number, slugInput: string): Repository {
    this.repositories.require(repository, actorUserId, 'admin');
    const slug = validateSlug(slugInput, 'repository');
    this.database
      .prepare('UPDATE repositories SET slug = ?, updated_at = ? WHERE id = ?')
      .run(slug, new Date().toISOString(), repository.id);
    this.audit.record({
      actorUserId,
      action: 'repository.renamed',
      targetType: 'repository',
      targetId: String(repository.id),
      metadata: { previous: repository.slug, current: slug },
    });
    const updated = this.repositories.getById(repository.id);
    this.publishEvent('repository.renamed', repositoryEvent(updated));
    return updated;
  }

  changeVisibility(
    repository: Repository,
    actorUserId: number,
    visibility: Visibility,
  ): Repository {
    this.repositories.require(repository, actorUserId, 'admin');
    this.database
      .prepare('UPDATE repositories SET visibility = ?, updated_at = ? WHERE id = ?')
      .run(visibility, new Date().toISOString(), repository.id);
    this.audit.record({
      actorUserId,
      action: 'repository.visibilityChanged',
      targetType: 'repository',
      targetId: String(repository.id),
      metadata: { previous: repository.visibility, current: visibility },
    });
    const updated = this.repositories.getById(repository.id);
    this.publishEvent('repository.visibilityChanged', repositoryEvent(updated));
    return updated;
  }

  async updateDetails(
    repository: Repository,
    actorUserId: number,
    descriptionInput: string,
    defaultBranchInput: string,
  ): Promise<Repository> {
    this.repositories.require(repository, actorUserId, 'admin');
    const description = descriptionInput.trim();
    if (description.length > 500)
      throw new RepositoryAdminInputError('Description is too long', 400);
    const defaultBranch = validateRef(defaultBranchInput);
    await this.repositories.resolveCommit(repository, defaultBranch);
    if (repository.storageKind !== 'working_tree') {
      await this.repositories.updateDefaultBranchHead(repository, defaultBranch);
    }
    this.database
      .prepare(
        'UPDATE repositories SET description = ?, default_branch = ?, updated_at = ? WHERE id = ?',
      )
      .run(description, defaultBranch, new Date().toISOString(), repository.id);
    this.audit.record({
      actorUserId,
      action: 'repository.settingsChanged',
      targetType: 'repository',
      targetId: String(repository.id),
      metadata: { defaultBranch },
    });
    return this.repositories.getById(repository.id);
  }

  transfer(
    repository: Repository,
    actorUserId: number,
    targetType: 'user' | 'group',
    targetSlug: string,
  ): Repository {
    this.repositories.require(repository, actorUserId, 'owner');
    const target = this.database
      .prepare(
        targetType === 'user'
          ? "SELECT id FROM users WHERE username = ? AND status = 'active'"
          : 'SELECT id FROM groups WHERE slug = ?',
      )
      .get(targetSlug.toLowerCase()) as { id: number } | undefined;
    if (!target) throw new RepositoryAdminInputError('Target owner not found', 404);
    if (targetType === 'group') {
      const role = this.database
        .prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
        .get(target.id, actorUserId) as { role: string } | undefined;
      if (role?.role !== 'owner')
        throw new RepositoryAdminInputError('You must own the target group', 403);
    } else if (target.id !== actorUserId) {
      const now = new Date();
      this.database
        .prepare(
          `INSERT INTO repository_transfers
            (repository_id, source_owner_type, source_owner_id, target_user_id, requested_by,
             created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(repository_id) DO UPDATE SET
             source_owner_type = excluded.source_owner_type,
             source_owner_id = excluded.source_owner_id,
             target_user_id = excluded.target_user_id,
             requested_by = excluded.requested_by,
             created_at = excluded.created_at,
             expires_at = excluded.expires_at`,
        )
        .run(
          repository.id,
          repository.ownerType,
          repository.ownerId,
          target.id,
          actorUserId,
          now.toISOString(),
          new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        );
      this.audit.record({
        actorUserId,
        action: 'repository.transferRequested',
        targetType: 'repository',
        targetId: String(repository.id),
        metadata: { targetUserId: target.id, expiresInDays: 7 },
      });
      return repository;
    }
    this.database
      .prepare('UPDATE repositories SET owner_type = ?, owner_id = ?, updated_at = ? WHERE id = ?')
      .run(targetType, target.id, new Date().toISOString(), repository.id);
    this.database
      .prepare('DELETE FROM repository_transfers WHERE repository_id = ?')
      .run(repository.id);
    this.audit.record({
      actorUserId,
      action: 'repository.transferred',
      targetType: 'repository',
      targetId: String(repository.id),
      metadata: { ownerType: targetType, ownerId: target.id },
    });
    return this.repositories.getById(repository.id);
  }

  pendingTransfers(userId: number): {
    repositoryId: number;
    owner: string;
    repository: string;
    requestedBy: string;
    expiresAt: string;
  }[] {
    return this.database
      .prepare(
        `SELECT rt.repository_id AS repositoryId,
                CASE rt.source_owner_type WHEN 'user' THEN owner_user.username ELSE owner_group.slug END AS owner,
                r.slug AS repository, requester.username AS requestedBy, rt.expires_at AS expiresAt
         FROM repository_transfers rt
         JOIN repositories r ON r.id = rt.repository_id AND r.deleted_at IS NULL
         JOIN users requester ON requester.id = rt.requested_by
         LEFT JOIN users owner_user ON rt.source_owner_type = 'user' AND owner_user.id = rt.source_owner_id
         LEFT JOIN groups owner_group ON rt.source_owner_type = 'group' AND owner_group.id = rt.source_owner_id
         WHERE rt.target_user_id = ? AND rt.expires_at > ?
         ORDER BY rt.created_at`,
      )
      .all(userId, new Date().toISOString()) as {
      repositoryId: number;
      owner: string;
      repository: string;
      requestedBy: string;
      expiresAt: string;
    }[];
  }

  resolveTransfer(repositoryId: number, targetUserId: number, accept: boolean): Repository | null {
    const now = new Date().toISOString();
    const transfer = this.database
      .prepare(
        `SELECT source_owner_type AS sourceOwnerType, source_owner_id AS sourceOwnerId
         FROM repository_transfers
         WHERE repository_id = ? AND target_user_id = ? AND expires_at > ?`,
      )
      .get(repositoryId, targetUserId, now) as
      { sourceOwnerType: 'user' | 'group'; sourceOwnerId: number } | undefined;
    if (!transfer) throw new RepositoryAdminInputError('Transfer request not found', 404);
    let updated: Repository | null = null;
    this.database.transaction(() => {
      if (accept) {
        const changed = this.database
          .prepare(
            `UPDATE repositories SET owner_type = 'user', owner_id = ?, updated_at = ?
             WHERE id = ? AND owner_type = ? AND owner_id = ? AND deleted_at IS NULL`,
          )
          .run(targetUserId, now, repositoryId, transfer.sourceOwnerType, transfer.sourceOwnerId);
        if (changed.changes !== 1)
          throw new RepositoryAdminInputError('Repository ownership changed', 409);
      }
      this.database
        .prepare('DELETE FROM repository_transfers WHERE repository_id = ?')
        .run(repositoryId);
      this.audit.record({
        actorUserId: targetUserId,
        action: accept ? 'repository.transferAccepted' : 'repository.transferDeclined',
        targetType: 'repository',
        targetId: String(repositoryId),
      });
    })();
    if (accept) {
      updated = this.repositories.getById(repositoryId);
    }
    return updated;
  }

  setGrant(
    repository: Repository,
    actorUserId: number,
    principalType: 'user' | 'group',
    principalId: number,
    level: Exclude<Permission, 'none' | 'owner'>,
  ): void {
    this.repositories.require(repository, actorUserId, 'admin');
    this.database
      .prepare(
        `
        INSERT INTO repository_grants(repository_id, principal_type, principal_id, level)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(repository_id, principal_type, principal_id) DO UPDATE SET level = excluded.level
      `,
      )
      .run(repository.id, principalType, principalId, level);
    this.audit.record({
      actorUserId,
      action: 'repository.permissionChanged',
      targetType: 'repository',
      targetId: String(repository.id),
      metadata: { principalType, principalId, level },
    });
  }

  setGrantByName(
    repository: Repository,
    actorUserId: number,
    principalType: 'user' | 'group',
    principalName: string,
    level: Exclude<Permission, 'none' | 'owner'>,
  ): void {
    const row = this.database
      .prepare(
        principalType === 'user'
          ? "SELECT id FROM users WHERE username = ? AND status = 'active'"
          : 'SELECT id FROM groups WHERE slug = ?',
      )
      .get(principalName.toLowerCase()) as { id: number } | undefined;
    if (!row) throw new RepositoryAdminInputError('Collaborator not found', 404);
    if (principalType === repository.ownerType && row.id === repository.ownerId)
      throw new RepositoryAdminInputError('The repository owner already has full authority', 409);
    this.setGrant(repository, actorUserId, principalType, row.id, level);
  }

  removeGrant(
    repository: Repository,
    actorUserId: number,
    principalType: 'user' | 'group',
    principalId: number,
  ): void {
    this.repositories.require(repository, actorUserId, 'admin');
    this.database
      .prepare(
        'DELETE FROM repository_grants WHERE repository_id = ? AND principal_type = ? AND principal_id = ?',
      )
      .run(repository.id, principalType, principalId);
    this.audit.record({
      actorUserId,
      action: 'repository.permissionRemoved',
      targetType: 'repository',
      targetId: String(repository.id),
      metadata: { principalType, principalId },
    });
  }

  grants(repository: Repository, actorUserId: number): unknown[] {
    this.repositories.require(repository, actorUserId, 'admin');
    return this.database
      .prepare(
        `SELECT rg.principal_type AS principalType, rg.principal_id AS principalId, rg.level, COALESCE(u.username, g.slug) AS name FROM repository_grants rg LEFT JOIN users u ON rg.principal_type = 'user' AND u.id = rg.principal_id LEFT JOIN groups g ON rg.principal_type = 'group' AND g.id = rg.principal_id WHERE rg.repository_id = ? ORDER BY name`,
      )
      .all(repository.id);
  }

  async delete(repository: Repository, actorUserId: number): Promise<void> {
    this.repositories.require(repository, actorUserId, 'owner');
    const now = new Date().toISOString();
    if (repository.storageKind !== 'hosted_bare') {
      this.database
        .prepare('UPDATE repositories SET deleted_at = ? WHERE id = ?')
        .run(now, repository.id);
    } else {
      const source = await this.repositories.storagePath(repository);
      await mkdir(this.config.storage.trash, { recursive: true, mode: 0o750 });
      const destination = join(
        this.config.storage.trash,
        `${repository.storageId}.${String(Date.now())}.git`,
      );
      await rename(source, destination);
      try {
        this.database
          .prepare('UPDATE repositories SET deleted_at = ?, storage_path = ? WHERE id = ?')
          .run(now, destination, repository.id);
      } catch (error) {
        await rename(destination, source);
        throw error;
      }
    }
    this.audit.record({
      actorUserId,
      action: 'repository.deleted',
      targetType: 'repository',
      targetId: String(repository.id),
      metadata: { storageKind: repository.storageKind },
    });
    this.publishEvent('repository.deleted', repositoryEvent(repository));
  }

  async purgeExpiredTrash(): Promise<number> {
    await mkdir(this.config.storage.trash, { recursive: true, mode: 0o750 });
    const trashRoot = await realpath(this.config.storage.trash);
    const cutoff = new Date(
      Date.now() - this.config.security.repositoryTrashDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const rows = this.database
      .prepare(
        `SELECT id, storage_path AS storagePath FROM repositories
         WHERE storage_kind = 'hosted_bare' AND deleted_at IS NOT NULL AND deleted_at <= ?`,
      )
      .all(cutoff) as { id: number; storagePath: string }[];
    let purged = 0;
    for (const row of rows) {
      const logicalRelative = relative(trashRoot, row.storagePath);
      if (
        !isAbsolute(row.storagePath) ||
        logicalRelative === '' ||
        logicalRelative.startsWith('..') ||
        isAbsolute(logicalRelative)
      )
        continue;
      try {
        const info = await lstat(row.storagePath);
        if (info.isSymbolicLink() || !info.isDirectory()) continue;
        const canonical = await realpath(row.storagePath);
        const canonicalRelative = relative(trashRoot, canonical);
        if (canonicalRelative.startsWith('..') || isAbsolute(canonicalRelative)) continue;
        await rm(canonical, { recursive: true, force: false });
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
      this.database.transaction(() => {
        this.audit.record({
          action: 'repository.trashPurged',
          targetType: 'repository',
          targetId: String(row.id),
          metadata: { retentionDays: this.config.security.repositoryTrashDays },
        });
        this.database
          .prepare('DELETE FROM repositories WHERE id = ? AND deleted_at IS NOT NULL')
          .run(row.id);
      })();
      purged += 1;
    }
    return purged;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function repositoryEvent(repository: Repository): Readonly<Record<string, unknown>> {
  return {
    repositoryId: repository.id,
    owner: repository.ownerSlug,
    repository: repository.slug,
    visibility: repository.visibility,
  };
}

export class RepositoryAdminInputError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}
