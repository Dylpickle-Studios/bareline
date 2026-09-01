import { createHmac, randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { product } from '../app/metadata.js';
import type { AuditService } from '../audit/audit-service.js';
import type { AppConfig } from '../config/config.js';
import type { Database } from '../database/database.js';
import { base32Decode, base32Encode } from '../security/base32.js';
import { SecretBox } from '../security/secret-box.js';
import { hashSecret } from './auth-service.js';

const STEP_SECONDS = 30;
const BACKUP_CODE_COUNT = 10;
const PENDING_LOGIN_TTL_MS = 300_000;

export class TotpService {
  private readonly box: SecretBox | null;

  constructor(
    private readonly database: Database,
    config: AppConfig,
    private readonly audit: AuditService,
  ) {
    this.box = config.security.masterKey ? new SecretBox(config.security.masterKey) : null;
  }

  isEnabled(userId: number): boolean {
    const row = this.database
      .prepare('SELECT confirmed_at FROM totp_credentials WHERE user_id = ?')
      .get(userId) as { confirmed_at: string | null } | undefined;
    return row?.confirmed_at != null;
  }

  backupCodeCount(userId: number): number {
    return (
      this.database
        .prepare('SELECT count(*) AS count FROM totp_backup_codes WHERE user_id = ?')
        .get(userId) as { count: number }
    ).count;
  }

  async beginEnrollment(
    userId: number,
    username: string,
  ): Promise<{ secret: string; otpauthUrl: string; qrCodeDataUrl: string }> {
    if (!this.box)
      throw new TotpError('security.masterKey is required for two-factor authentication', 503);
    if (this.isEnabled(userId))
      throw new TotpError('Two-factor authentication is already enabled', 409);
    const secret = base32Encode(randomBytes(20));
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO totp_credentials(user_id, secret_encrypted, confirmed_at, last_used_step, created_at)
         VALUES (?, ?, NULL, NULL, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           secret_encrypted = excluded.secret_encrypted, confirmed_at = NULL,
           last_used_step = NULL, created_at = excluded.created_at`,
      )
      .run(userId, this.box.encrypt(secret, secretContext(userId)), now);
    return await this.buildEnrollmentView(secret, username);
  }

  /** Re-renders the QR/secret for a still-pending enrollment without minting a new secret. */
  async pendingEnrollment(
    userId: number,
    username: string,
  ): Promise<{ secret: string; otpauthUrl: string; qrCodeDataUrl: string } | null> {
    if (!this.box)
      throw new TotpError('security.masterKey is required for two-factor authentication', 503);
    const row = this.database
      .prepare(
        'SELECT secret_encrypted FROM totp_credentials WHERE user_id = ? AND confirmed_at IS NULL',
      )
      .get(userId) as { secret_encrypted: Buffer } | undefined;
    if (!row) return null;
    return await this.buildEnrollmentView(
      this.box.decrypt(row.secret_encrypted, secretContext(userId)),
      username,
    );
  }

  private async buildEnrollmentView(
    secret: string,
    username: string,
  ): Promise<{ secret: string; otpauthUrl: string; qrCodeDataUrl: string }> {
    const otpauthUrl =
      `otpauth://totp/${encodeURIComponent(product.name)}:${encodeURIComponent(username)}` +
      `?secret=${secret}&issuer=${encodeURIComponent(product.name)}&algorithm=SHA1&digits=6&period=${String(STEP_SECONDS)}`;
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
    });
    return { secret, otpauthUrl, qrCodeDataUrl };
  }

  confirmEnrollment(userId: number, codeInput: string): string[] {
    if (!this.box)
      throw new TotpError('security.masterKey is required for two-factor authentication', 503);
    const row = this.database
      .prepare(
        'SELECT secret_encrypted FROM totp_credentials WHERE user_id = ? AND confirmed_at IS NULL',
      )
      .get(userId) as { secret_encrypted: Buffer } | undefined;
    if (!row) throw new TotpError('Two-factor enrollment was not started', 409);
    const secret = this.box.decrypt(row.secret_encrypted, secretContext(userId));
    if (matchStep(secret, codeInput.trim(), null) === null)
      throw new TotpError('The authentication code was not accepted', 401);
    const codes = generateBackupCodes();
    const now = new Date().toISOString();
    this.database.transaction(() => {
      // Deliberately leave last_used_step NULL: this proves possession of the secret, it isn't a
      // login, so it must not consume the current 30s code and block an immediate first login.
      this.database
        .prepare('UPDATE totp_credentials SET confirmed_at = ? WHERE user_id = ?')
        .run(now, userId);
      this.database.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').run(userId);
      const insert = this.database.prepare(
        'INSERT INTO totp_backup_codes(user_id, code_hash, created_at) VALUES (?, ?, ?)',
      );
      for (const code of codes) insert.run(userId, hashSecret(normalizeBackupCode(code)), now);
      this.audit.record({
        actorUserId: userId,
        action: 'totp.enabled',
        targetType: 'user',
        targetId: String(userId),
      });
    })();
    return codes;
  }

  disable(userId: number, actorUserId: number): void {
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM totp_credentials WHERE user_id = ?').run(userId);
      this.database.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').run(userId);
      this.audit.record({
        actorUserId,
        action: 'totp.disabled',
        targetType: 'user',
        targetId: String(userId),
      });
    })();
  }

  regenerateBackupCodes(userId: number): string[] {
    if (!this.isEnabled(userId))
      throw new TotpError('Two-factor authentication is not enabled', 409);
    const codes = generateBackupCodes();
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').run(userId);
      const insert = this.database.prepare(
        'INSERT INTO totp_backup_codes(user_id, code_hash, created_at) VALUES (?, ?, ?)',
      );
      for (const code of codes) insert.run(userId, hashSecret(normalizeBackupCode(code)), now);
      this.audit.record({
        actorUserId: userId,
        action: 'totp.backupCodesRegenerated',
        targetType: 'user',
        targetId: String(userId),
        metadata: { count: codes.length },
      });
    })();
    return codes;
  }

  beginLogin(userId: number, userAgent?: string): { token: string; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PENDING_LOGIN_TTL_MS);
    this.database.transaction(() => {
      this.database
        .prepare('DELETE FROM totp_pending_logins WHERE expires_at < ?')
        .run(now.toISOString());
      this.database
        .prepare(
          'INSERT INTO totp_pending_logins(token_hash, user_id, user_agent, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          hashSecret(token),
          userId,
          userAgent ?? null,
          expiresAt.toISOString(),
          now.toISOString(),
        );
    })();
    return { token, expiresAt };
  }

  completeLogin(pendingToken: string, codeInput: string): number {
    const pending = this.database
      .prepare(
        'SELECT user_id AS userId FROM totp_pending_logins WHERE token_hash = ? AND expires_at >= ?',
      )
      .get(hashSecret(pendingToken), new Date().toISOString()) as { userId: number } | undefined;
    if (!pending) throw new TotpError('The sign-in attempt has expired; sign in again', 410);
    const code = codeInput.trim();
    if (/^\d{6}$/.test(code)) {
      if (!this.box)
        throw new TotpError('security.masterKey is required for two-factor authentication', 503);
      const row = this.database
        .prepare(
          'SELECT secret_encrypted, last_used_step FROM totp_credentials WHERE user_id = ? AND confirmed_at IS NOT NULL',
        )
        .get(pending.userId) as
        { secret_encrypted: Buffer; last_used_step: number | null } | undefined;
      const step = row
        ? matchStep(
            this.box.decrypt(row.secret_encrypted, secretContext(pending.userId)),
            code,
            row.last_used_step,
          )
        : null;
      if (step === null) throw new TotpError('The authentication code was not accepted', 401);
      this.database
        .prepare('UPDATE totp_credentials SET last_used_step = ? WHERE user_id = ?')
        .run(step, pending.userId);
      this.database
        .prepare('DELETE FROM totp_pending_logins WHERE token_hash = ?')
        .run(hashSecret(pendingToken));
      return pending.userId;
    }
    const consumed = this.database
      .prepare('DELETE FROM totp_backup_codes WHERE user_id = ? AND code_hash = ? RETURNING id')
      .get(pending.userId, hashSecret(normalizeBackupCode(code))) as { id: number } | undefined;
    if (!consumed) throw new TotpError('The authentication code was not accepted', 401);
    this.database
      .prepare('DELETE FROM totp_pending_logins WHERE token_hash = ?')
      .run(hashSecret(pendingToken));
    return pending.userId;
  }
}

export class TotpError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function secretContext(userId: number): string {
  return `totp:${String(userId)}`;
}

function currentStep(date = new Date()): number {
  return Math.floor(date.getTime() / 1000 / STEP_SECONDS);
}

function hotp(key: Buffer, counter: number): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(counterBuffer).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

function matchStep(base32Secret: string, code: string, lastUsedStep: number | null): number | null {
  const key = base32Decode(base32Secret);
  const current = currentStep();
  for (const step of [current - 1, current, current + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (hotp(key, step) === code) return step;
  }
  return null;
}

function generateBackupCodes(): string[] {
  return Array.from({ length: BACKUP_CODE_COUNT }, () =>
    formatBackupCode(randomBytes(10).toString('base64url')),
  );
}
function formatBackupCode(value: string): string {
  const normalized = value.toLowerCase();
  return `${normalized.slice(0, 5)}-${normalized.slice(5, 10)}-${normalized.slice(10)}`;
}
function normalizeBackupCode(value: string): string {
  return value.replaceAll('-', '').trim().toLowerCase();
}
