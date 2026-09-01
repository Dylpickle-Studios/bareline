import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { TotpError, TotpService } from '../src/auth/totp-service.js';
import { openDatabase } from '../src/database/database.js';
import { base32Decode } from '../src/security/base32.js';
import { temporaryConfig } from './helpers.js';

// Independent RFC 4226/6238 implementation, deliberately not shared with src/auth/totp-service.ts,
// so a bug in the service's own math would not also be reflected in the test's expectation.
function codeForSecret(secret: string, stepOffset = 0): string {
  const key = base32Decode(secret);
  const step = Math.floor(Date.now() / 1000 / 30) + stepOffset;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

function seedUser(database: ReturnType<typeof openDatabase>, username: string): number {
  const result = database
    .prepare(
      `INSERT INTO users(username, display_name, status, is_admin, created_at) VALUES (?, ?, 'active', 0, ?)`,
    )
    .run(username, username, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

describe('TOTP two-factor authentication', () => {
  it('requires a configured master key before enrollment can start', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const service = new TotpService(database, config, new AuditService(database));
    const userId = seedUser(database, 'alice');
    await expect(service.beginEnrollment(userId, 'alice')).rejects.toMatchObject({
      statusCode: 503,
    });
    database.close();
  });

  it('enrolls, confirms with a valid code, and issues one-time backup codes', async () => {
    const config = temporaryConfig();
    config.security.masterKey = randomBytes(32).toString('base64url');
    const database = openDatabase(config.database.path);
    const service = new TotpService(database, config, new AuditService(database));
    const userId = seedUser(database, 'alice');
    expect(service.isEnabled(userId)).toBe(false);
    const enrollment = await service.beginEnrollment(userId, 'alice');
    expect(enrollment.otpauthUrl).toContain(`secret=${enrollment.secret}`);
    const backupCodes = service.confirmEnrollment(userId, codeForSecret(enrollment.secret));
    expect(backupCodes).toHaveLength(10);
    expect(service.isEnabled(userId)).toBe(true);
    expect(service.backupCodeCount(userId)).toBe(10);
    const storedSecret = database
      .prepare('SELECT secret_encrypted FROM totp_credentials WHERE user_id = ?')
      .get(userId) as { secret_encrypted: Buffer };
    expect(storedSecret.secret_encrypted.toString('utf8')).not.toContain(enrollment.secret);
    database.close();
  });

  it('rejects an incorrect confirmation code and leaves enrollment unconfirmed', async () => {
    const config = temporaryConfig();
    config.security.masterKey = randomBytes(32).toString('base64url');
    const database = openDatabase(config.database.path);
    const service = new TotpService(database, config, new AuditService(database));
    const userId = seedUser(database, 'alice');
    await service.beginEnrollment(userId, 'alice');
    expect(() => service.confirmEnrollment(userId, '000000')).toThrow(TotpError);
    expect(service.isEnabled(userId)).toBe(false);
    database.close();
  });

  it('rejects replaying the same code twice at login and enforces a bounded pending-login window', async () => {
    const config = temporaryConfig();
    config.security.masterKey = randomBytes(32).toString('base64url');
    const database = openDatabase(config.database.path);
    const service = new TotpService(database, config, new AuditService(database));
    const userId = seedUser(database, 'alice');
    const enrollment = await service.beginEnrollment(userId, 'alice');
    service.confirmEnrollment(userId, codeForSecret(enrollment.secret));

    const firstAttempt = service.beginLogin(userId, 'test-agent');
    const code = codeForSecret(enrollment.secret);
    expect(service.completeLogin(firstAttempt.token, code)).toBe(userId);

    const secondAttempt = service.beginLogin(userId, 'test-agent');
    expect(() => service.completeLogin(secondAttempt.token, code)).toThrow(
      /authentication code was not accepted/,
    );

    database
      .prepare('UPDATE totp_pending_logins SET expires_at = ? WHERE token_hash IS NOT NULL')
      .run(new Date(Date.now() - 1000).toISOString());
    expect(() =>
      service.completeLogin(secondAttempt.token, codeForSecret(enrollment.secret, 1)),
    ).toThrow(/expired/);
    database.close();
  });

  it('accepts a backup code once at login and rejects reuse', async () => {
    const config = temporaryConfig();
    config.security.masterKey = randomBytes(32).toString('base64url');
    const database = openDatabase(config.database.path);
    const service = new TotpService(database, config, new AuditService(database));
    const userId = seedUser(database, 'alice');
    const enrollment = await service.beginEnrollment(userId, 'alice');
    const backupCodes = service.confirmEnrollment(userId, codeForSecret(enrollment.secret));
    const backupCode = backupCodes[0] ?? '';

    const pending = service.beginLogin(userId, 'test-agent');
    expect(service.completeLogin(pending.token, backupCode)).toBe(userId);
    expect(service.backupCodeCount(userId)).toBe(9);

    const secondPending = service.beginLogin(userId, 'test-agent');
    expect(() => service.completeLogin(secondPending.token, backupCode)).toThrow(
      /authentication code was not accepted/,
    );
    database.close();
  });

  it('disable() removes both the credential and any remaining backup codes', async () => {
    const config = temporaryConfig();
    config.security.masterKey = randomBytes(32).toString('base64url');
    const database = openDatabase(config.database.path);
    const service = new TotpService(database, config, new AuditService(database));
    const userId = seedUser(database, 'alice');
    const enrollment = await service.beginEnrollment(userId, 'alice');
    service.confirmEnrollment(userId, codeForSecret(enrollment.secret));
    service.disable(userId, userId);
    expect(service.isEnabled(userId)).toBe(false);
    expect(service.backupCodeCount(userId)).toBe(0);
    database.close();
  });
});
