import { afterEach, describe, expect, it, vi } from 'vitest';
import * as oidc from 'openid-client';
import { createApp } from '../src/app/create-app.js';
import { localReturnPath } from '../src/auth/external-auth-service.js';
import { auditFixture } from './audit-fixture.js';

vi.mock('openid-client', async (original) => ({
  ...(await original<typeof import('openid-client')>()),
  discovery: vi.fn().mockResolvedValue({}),
  buildAuthorizationUrl: vi.fn((_configuration: unknown, parameters: Record<string, string>) => {
    const url = new URL('https://identity.example/authorize');
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    return url;
  }),
  authorizationCodeGrant: vi.fn().mockResolvedValue({
    claims: () => ({ sub: 'external-subject', preferred_username: 'charlie', name: 'Charlie' }),
  }),
}));
afterEach(() => vi.clearAllMocks());

describe('OIDC transaction boundaries', () => {
  it('rejects callback transplantation, missing binding, replay, and expired transactions', async () => {
    const f = await auditFixture();
    f.config.authentication = {
      oidc: [
        {
          id: 'work',
          name: 'Work',
          issuer: 'https://identity.example',
          clientId: 'test-client',
          clientSecret: 'test-secret',
          scopes: ['openid'],
          usernameClaim: 'preferred_username',
          displayNameClaim: 'name',
          autoCreate: true,
        },
      ],
    };
    const app = await createApp(f.config);
    try {
      const start = await app.inject('/auth/oidc/work?return=%2Fsettings%2Fprofile');
      expect(start.statusCode).toBe(302);
      const binding = start.cookies.find((cookie) => cookie.name === 'oidc_binding');
      expect(binding).toMatchObject({ httpOnly: true, sameSite: 'Lax', maxAge: 600 });
      const state = new URL(String(start.headers.location)).searchParams.get('state');
      if (!state) throw new Error('Missing OIDC state');
      if (!binding) throw new Error('Missing browser binding');
      const callback = `/auth/oidc/work/callback?code=unused-code&state=${state}`;
      const second = await app.inject('/auth/oidc/work');
      const secondBinding = second.cookies.find((cookie) => cookie.name === 'oidc_binding');
      if (!secondBinding) throw new Error('Missing second browser binding');
      for (const cookie of ['', `oidc_binding=${secondBinding.value}`]) {
        const denied = await app.inject({ url: callback, headers: { cookie } });
        expect(denied.statusCode).toBe(400);
        expect(denied.cookies.some((cookie) => cookie.name === 'session')).toBe(false);
      }
      expect(oidc.authorizationCodeGrant).not.toHaveBeenCalled();
      const cookie = `oidc_binding=${binding.value}`;
      const accepted = await app.inject({ url: callback, headers: { cookie } });
      expect(accepted.statusCode).toBe(302);
      expect(accepted.headers.location).toBe('/settings/profile');
      expect(accepted.cookies.some((cookie) => cookie.name === 'session')).toBe(true);
      expect(oidc.authorizationCodeGrant).toHaveBeenCalledTimes(1);
      expect((await app.inject({ url: callback, headers: { cookie } })).statusCode).toBe(400);
      f.database
        .prepare("UPDATE external_authentication_flows SET expires_at = '2000-01-01T00:00:00.000Z'")
        .run();
      const expiredState = new URL(String(second.headers.location)).searchParams.get('state');
      if (!expiredState) throw new Error('Missing second OIDC state');
      expect(
        (
          await app.inject({
            url: `/auth/oidc/work/callback?code=x&state=${expiredState}`,
            headers: { cookie: `oidc_binding=${secondBinding.value}` },
          })
        ).statusCode,
      ).toBe(400);
      expect(oidc.authorizationCodeGrant).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      await f.cleanup();
    }
  });

  it('normalizes local return destinations and rejects encoded or literal external separators', () => {
    for (const path of [
      '//evil.example',
      '/\\evil.example',
      '/%5cevil.example',
      '/%2fevil.example',
      '/%0aevil',
      '/\tevil',
      'https://evil.example',
      '/%',
    ]) {
      expect(localReturnPath(path, 'https://bareline.example'), path).toBe('/');
    }
    expect(localReturnPath('/docs/../settings?tab=profile#name', 'https://bareline.example')).toBe(
      '/settings?tab=profile#name',
    );
  });
});
