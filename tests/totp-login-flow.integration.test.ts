import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app/create-app.js';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { TotpService } from '../src/auth/totp-service.js';
import { openDatabase } from '../src/database/database.js';
import { base32Decode } from '../src/security/base32.js';
import { temporaryConfig } from './helpers.js';

function codeForSecret(secret: string): string {
  const key = base32Decode(secret);
  const step = Math.floor(Date.now() / 1000 / 30);
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

describe('TOTP login flow', () => {
  it('gates password login behind a second factor once TOTP is enabled', async () => {
    const config = temporaryConfig();
    config.registration.mode = 'open';
    config.security.masterKey = randomBytes(32).toString('base64url');
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const auth = new AuthService(database, config, audit);
    const user = await auth.register({
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse battery staple',
    });
    const totp = new TotpService(database, config, audit);
    const enrollment = await totp.beginEnrollment(user.id, 'alice');
    totp.confirmEnrollment(user.id, codeForSecret(enrollment.secret));
    database.close();

    const app = await createApp(config);
    try {
      const loginPage = await app.inject({ method: 'GET', url: '/login' });
      const loginCsrf = /name="csrf" value="([^"]+)"/.exec(loginPage.body)?.[1];
      const loginFormCsrf = loginPage.cookies.find((cookie) => cookie.name === 'form_csrf')?.value;
      expect(loginCsrf).toBeTruthy();

      const passwordStep = await app.inject({
        method: 'POST',
        url: '/login',
        headers: { cookie: `form_csrf=${loginFormCsrf ?? ''}` },
        payload: { csrf: loginCsrf, username: 'alice', password: 'correct horse battery staple' },
      });
      expect(passwordStep.statusCode).toBe(302);
      expect(passwordStep.headers.location).toBe('/login/totp');
      expect(passwordStep.cookies.some((cookie) => cookie.name === 'session')).toBe(false);
      const pendingCookie = passwordStep.cookies.find((cookie) => cookie.name === 'totp_pending');
      expect(pendingCookie).toBeTruthy();

      const totpPage = await app.inject({
        method: 'GET',
        url: '/login/totp',
        headers: { cookie: `totp_pending=${pendingCookie?.value ?? ''}` },
      });
      expect(totpPage.statusCode).toBe(200);
      const totpCsrf = /name="csrf" value="([^"]+)"/.exec(totpPage.body)?.[1];
      const totpFormCsrf = totpPage.cookies.find((cookie) => cookie.name === 'form_csrf')?.value;

      const wrongCode = await app.inject({
        method: 'POST',
        url: '/login/totp',
        headers: {
          cookie: `totp_pending=${pendingCookie?.value ?? ''}; form_csrf=${totpFormCsrf ?? ''}`,
        },
        payload: { csrf: totpCsrf, code: '000000' },
      });
      expect(wrongCode.statusCode).toBe(401);
      expect(wrongCode.cookies.some((cookie) => cookie.name === 'session')).toBe(false);

      const correctCode = await app.inject({
        method: 'POST',
        url: '/login/totp',
        headers: {
          cookie: `totp_pending=${pendingCookie?.value ?? ''}; form_csrf=${totpFormCsrf ?? ''}`,
        },
        payload: { csrf: totpCsrf, code: codeForSecret(enrollment.secret) },
      });
      expect(correctCode.statusCode).toBe(302);
      expect(correctCode.headers.location).toBe('/');
      expect(correctCode.cookies.some((cookie) => cookie.name === 'session')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('never discloses whether an account has two-factor enabled when no login is in progress', async () => {
    const config = temporaryConfig();
    const app = await createApp(config);
    try {
      const response = await app.inject({ method: 'GET', url: '/login/totp' });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });
});
