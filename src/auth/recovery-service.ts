import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { AuditService } from '../audit/audit-service.js';
import type { Database } from '../database/database.js';
import { hashSecret } from './auth-service.js';

export class RecoveryService {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
  ) {}

  generate(userId: number): string[] {
    return this.replaceCodes(userId, userId, 10, 'recoveryCodes.regenerated');
  }

  issueAdministratorCode(actorUserId: number, targetUserId: number): string {
    const actor = this.database
      .prepare("SELECT id FROM users WHERE id = ? AND status = 'active' AND is_admin = 1")
      .get(actorUserId);
    const target = this.database
      .prepare("SELECT id FROM users WHERE id = ? AND status = 'active'")
      .get(targetUserId);
    if (!actor || !target)
      throw new RecoveryError('Active administrator and user are required', 403);
    return (
      this.replaceCodes(targetUserId, actorUserId, 1, 'recoveryCode.administratorIssued')[0] ?? ''
    );
  }

  private replaceCodes(
    userId: number,
    actorUserId: number,
    count: number,
    action: string,
  ): string[] {
    const codes = Array.from({ length: count }, () =>
      formatCode(randomBytes(10).toString('base64url')),
    );
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
      const insert = this.database.prepare(
        'INSERT INTO recovery_codes(user_id, code_hash, created_at) VALUES (?, ?, ?)',
      );
      for (const code of codes) insert.run(userId, hashSecret(normalizeCode(code)), now);
      this.audit.record({
        actorUserId,
        action,
        targetType: 'user',
        targetId: String(userId),
        metadata: { count: codes.length, invalidatedPreviousCodes: true },
      });
    })();
    return codes;
  }

  count(userId: number): number {
    return (
      this.database
        .prepare('SELECT count(*) AS count FROM recovery_codes WHERE user_id = ?')
        .get(userId) as { count: number }
    ).count;
  }

  async resetPassword(
    usernameInput: string,
    codeInput: string,
    newPassword: string,
    requestId?: string,
    ip?: string,
  ): Promise<void> {
    if (newPassword.length < 12 || newPassword.length > 1024)
      throw new RecoveryError('Password must be between 12 and 1024 characters');
    const username = usernameInput.normalize('NFKC').toLowerCase();
    const row = this.database
      .prepare(
        "SELECT r.id AS recoveryId, u.id AS userId FROM users u JOIN recovery_codes r ON r.user_id = u.id WHERE u.username = ? AND u.status = 'active' AND r.code_hash = ?",
      )
      .get(username, hashSecret(normalizeCode(codeInput))) as
      { recoveryId: number; userId: number } | undefined;
    const passwordHash = await argon2.hash(newPassword, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });
    if (!row) throw new RecoveryError('Recovery details were not accepted', 401);
    this.database.transaction(() => {
      const consumed = this.database
        .prepare('DELETE FROM recovery_codes WHERE id = ? AND user_id = ?')
        .run(row.recoveryId, row.userId);
      if (consumed.changes !== 1) throw new RecoveryError('Recovery code was already used', 409);
      this.database
        .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run(passwordHash, row.userId);
      this.database.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.userId);
      this.audit.record({
        actorUserId: row.userId,
        action: 'password.recovered',
        targetType: 'user',
        targetId: String(row.userId),
        requestId,
        ip,
      });
    })();
  }
}

function normalizeCode(value: string): string {
  return value.replaceAll('-', '').trim().toLowerCase();
}
function formatCode(value: string): string {
  const normalized = value.toLowerCase();
  return `${normalized.slice(0, 5)}-${normalized.slice(5, 10)}-${normalized.slice(10)}`;
}
export class RecoveryError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}
