import { randomBytes } from 'node:crypto';
import type { AuditService } from '../audit/audit-service.js';
import type { Database } from '../database/database.js';
import { hashSecret } from './auth-service.js';

export class InviteService {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
  ) {}

  create(actorUserId: number, expiresInDays = 7): string {
    this.requireAdministrator(actorUserId);
    if (!Number.isSafeInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 30)
      throw new InviteInputError('Invite expiration must be between 1 and 30 days');
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const result = this.database
      .prepare(
        'INSERT INTO invites(token_hash, created_by, expires_at, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(
        hashSecret(token),
        actorUserId,
        new Date(now.getTime() + expiresInDays * 86_400_000).toISOString(),
        now.toISOString(),
      );
    this.audit.record({
      actorUserId,
      action: 'invite.created',
      targetType: 'invite',
      targetId: String(result.lastInsertRowid),
      metadata: { expiresInDays },
    });
    return token;
  }

  list(): { id: number; expiresAt: string; usedAt: string | null; createdAt: string }[] {
    return this.database
      .prepare(
        'SELECT id, expires_at AS expiresAt, used_at AS usedAt, created_at AS createdAt FROM invites ORDER BY id DESC LIMIT 200',
      )
      .all() as { id: number; expiresAt: string; usedAt: string | null; createdAt: string }[];
  }

  revoke(actorUserId: number, inviteId: number): void {
    this.requireAdministrator(actorUserId);
    const result = this.database
      .prepare('DELETE FROM invites WHERE id = ? AND used_at IS NULL')
      .run(inviteId);
    if (result.changes !== 1) throw new InviteInputError('Unused invite not found');
    this.audit.record({
      actorUserId,
      action: 'invite.revoked',
      targetType: 'invite',
      targetId: String(inviteId),
    });
  }

  private requireAdministrator(userId: number): void {
    const user = this.database
      .prepare("SELECT is_admin AS isAdmin FROM users WHERE id = ? AND status = 'active'")
      .get(userId) as { isAdmin: number } | undefined;
    if (user?.isAdmin !== 1) throw new InviteInputError('Administrator access required', 403);
  }
}

export class InviteInputError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}
