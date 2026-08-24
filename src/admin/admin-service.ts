import type { AuditService } from '../audit/audit-service.js';
import type { Database } from '../database/database.js';

export class AdminService {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
  ) {}

  users(): unknown[] {
    return this.database
      .prepare(
        `SELECT id, username, display_name AS displayName, status, is_admin AS isAdmin, created_at AS createdAt FROM users ORDER BY username`,
      )
      .all();
  }

  repositories(): unknown[] {
    return this.database
      .prepare(
        `
      SELECT r.id, r.slug, r.visibility, r.storage_kind AS storageKind, r.updated_at AS updatedAt,
        CASE r.owner_type WHEN 'user' THEN u.username ELSE g.slug END AS owner
      FROM repositories r LEFT JOIN users u ON r.owner_type = 'user' AND u.id = r.owner_id
      LEFT JOIN groups g ON r.owner_type = 'group' AND g.id = r.owner_id
      WHERE r.deleted_at IS NULL ORDER BY owner, r.slug
    `,
      )
      .all();
  }

  auditEvents(limit = 100, offset = 0): unknown[] {
    return this.database
      .prepare(
        `
      SELECT a.id, a.action, a.target_type AS targetType, a.target_id AS targetId,
        a.created_at AS createdAt, a.ip, u.username AS actor, a.metadata_json AS metadata
      FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
      ORDER BY a.id DESC LIMIT ? OFFSET ?
    `,
      )
      .all(Math.min(Math.max(limit, 1), 200), Math.max(offset, 0));
  }

  counts(): Record<string, number> {
    const count = (table: string, where = '') =>
      (
        this.database.prepare(`SELECT count(*) AS count FROM ${table} ${where}`).get() as {
          count: number;
        }
      ).count;
    return {
      users: count('users'),
      groups: count('groups'),
      repositories: count('repositories', 'WHERE deleted_at IS NULL'),
      plugins: count('plugins'),
      sessions: count('sessions', "WHERE expires_at > datetime('now')"),
    };
  }

  setUserStatus(actorUserId: number | null, userId: number, status: 'active' | 'disabled'): void {
    if (actorUserId !== null && actorUserId === userId && status === 'disabled')
      throw new AdminError('You cannot disable your own account');
    const target = this.database.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId) as
      { is_admin: number } | undefined;
    if (!target) throw new AdminError('User not found');
    if (status === 'disabled' && target.is_admin === 1 && this.activeAdministratorCount() <= 1)
      throw new AdminError('The last active administrator cannot be disabled');
    this.database.transaction(() => {
      this.database.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId);
      if (status === 'disabled')
        this.database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      this.audit.record({
        ...(actorUserId === null ? {} : { actorUserId }),
        action: status === 'active' ? 'user.enabled' : 'user.disabled',
        targetType: 'user',
        targetId: String(userId),
      });
    })();
  }

  setAdministrator(actorUserId: number | null, userId: number, administrator: boolean): void {
    if (actorUserId !== null && actorUserId === userId && !administrator)
      throw new AdminError('You cannot remove your own administrator access');
    const target = this.database.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId) as
      { is_admin: number } | undefined;
    if (!target) throw new AdminError('User not found');
    if (!administrator && target.is_admin === 1 && this.activeAdministratorCount() <= 1)
      throw new AdminError('The last active administrator cannot be demoted');
    this.database.transaction(() => {
      this.database
        .prepare('UPDATE users SET is_admin = ? WHERE id = ?')
        .run(administrator ? 1 : 0, userId);
      this.audit.record({
        ...(actorUserId === null ? {} : { actorUserId }),
        action: administrator ? 'user.promoted' : 'user.demoted',
        targetType: 'user',
        targetId: String(userId),
      });
    })();
  }

  private activeAdministratorCount(): number {
    return (
      this.database
        .prepare("SELECT count(*) AS count FROM users WHERE is_admin = 1 AND status = 'active'")
        .get() as { count: number }
    ).count;
  }
}

export class AdminError extends Error {
  readonly statusCode = 409;
}
