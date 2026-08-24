import type { AuditService } from '../audit/audit-service.js';
import type { Database } from '../database/database.js';
import { validateSlug } from '../security/validation.js';

export type GroupRole = 'member' | 'manager' | 'owner';

export class GroupService {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
  ) {}

  create(actorUserId: number, slugInput: string, displayNameInput: string): number {
    const slug = validateSlug(slugInput, 'group');
    const displayName = displayNameInput.trim();
    if (displayName.length < 1 || displayName.length > 100)
      throw new GroupInputError('Group name is required');
    const groupId = this.database.transaction(() => {
      const result = this.database
        .prepare('INSERT INTO groups(slug, display_name, created_at) VALUES (?, ?, ?)')
        .run(slug, displayName, new Date().toISOString());
      const id = Number(result.lastInsertRowid);
      this.database
        .prepare("INSERT INTO group_members(group_id, user_id, role) VALUES (?, ?, 'owner')")
        .run(id, actorUserId);
      this.audit.record({
        actorUserId,
        action: 'group.created',
        targetType: 'group',
        targetId: String(id),
      });
      return id;
    })();
    return groupId;
  }

  addMember(actorUserId: number, groupId: number, username: string, role: GroupRole): void {
    const actorRole = this.requireManager(groupId, actorUserId);
    if (role === 'owner' && actorRole !== 'owner') throw new GroupAuthorizationError();
    const user = this.database
      .prepare("SELECT id FROM users WHERE username = ? AND status = 'active'")
      .get(username.toLowerCase()) as { id: number } | undefined;
    if (!user) throw new GroupInputError('User not found');
    this.database
      .prepare(
        `
        INSERT INTO group_members(group_id, user_id, role) VALUES (?, ?, ?)
        ON CONFLICT(group_id, user_id) DO UPDATE SET role = excluded.role
      `,
      )
      .run(groupId, user.id, role);
    this.audit.record({
      actorUserId,
      action: 'group.memberChanged',
      targetType: 'group',
      targetId: String(groupId),
      metadata: { userId: user.id, role },
    });
  }

  removeMember(actorUserId: number, groupId: number, userId: number): void {
    const actorRole = this.requireManager(groupId, actorUserId);
    const target = this.database
      .prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(groupId, userId) as { role: GroupRole } | undefined;
    if (!target) throw new GroupInputError('Group member not found');
    if (target.role === 'owner' && actorRole !== 'owner') throw new GroupAuthorizationError();
    if (target.role === 'owner') {
      const owners = this.database
        .prepare(
          "SELECT count(*) AS count FROM group_members WHERE group_id = ? AND role = 'owner'",
        )
        .get(groupId) as { count: number };
      if (owners.count <= 1) throw new GroupInputError('A group must retain at least one owner');
    }
    this.database
      .prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?')
      .run(groupId, userId);
    this.audit.record({
      actorUserId,
      action: 'group.memberRemoved',
      targetType: 'group',
      targetId: String(groupId),
      metadata: { userId },
    });
  }

  role(groupId: number, userId: number): GroupRole | null {
    const row = this.database
      .prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(groupId, userId) as { role: GroupRole } | undefined;
    return row?.role ?? null;
  }

  listForUser(
    userId: number,
  ): { id: number; slug: string; displayName: string; role: GroupRole }[] {
    return this.database
      .prepare(
        'SELECT g.id, g.slug, g.display_name AS displayName, gm.role FROM groups g JOIN group_members gm ON gm.group_id = g.id WHERE gm.user_id = ? ORDER BY g.slug',
      )
      .all(userId) as { id: number; slug: string; displayName: string; role: GroupRole }[];
  }

  getBySlug(
    slug: string,
    userId: number,
  ): {
    id: number;
    slug: string;
    displayName: string;
    role: GroupRole;
    members: { id: number; username: string; displayName: string; role: GroupRole }[];
  } {
    const group = this.database
      .prepare('SELECT id, slug, display_name AS displayName FROM groups WHERE slug = ?')
      .get(slug.toLowerCase()) as { id: number; slug: string; displayName: string } | undefined;
    if (!group) throw new GroupInputError('Group not found');
    const role = this.role(group.id, userId);
    if (!role) throw new GroupAuthorizationError();
    const members = this.database
      .prepare(
        'SELECT u.id, u.username, u.display_name AS displayName, gm.role FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY u.username',
      )
      .all(group.id) as { id: number; username: string; displayName: string; role: GroupRole }[];
    return { ...group, role, members };
  }

  private requireManager(groupId: number, userId: number): 'manager' | 'owner' {
    const role = this.role(groupId, userId);
    if (role !== 'manager' && role !== 'owner') throw new GroupAuthorizationError();
    return role;
  }
}

export class GroupInputError extends Error {
  readonly statusCode = 400;
}
export class GroupAuthorizationError extends Error {
  readonly statusCode = 403;
}
