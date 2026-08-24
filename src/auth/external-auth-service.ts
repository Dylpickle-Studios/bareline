import { randomBytes } from 'node:crypto';
import { Client, Filter } from 'ldapts';
import * as oidc from 'openid-client';
import type { AppConfig } from '../config/config.js';
import type { Database } from '../database/database.js';
import { SecretBox } from '../security/secret-box.js';
import { validateSlug } from '../security/validation.js';
import { AuthService, hashSecret, type AuthenticatedUser } from './auth-service.js';

type OidcProvider = NonNullable<AppConfig['authentication']>['oidc'][number];

export class ExternalAuthService {
  private readonly configurations = new Map<string, Promise<oidc.Configuration>>();
  private readonly secretBox: SecretBox | null;

  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly auth: AuthService,
  ) {
    const needsEncryption = (config.authentication?.oidc.length ?? 0) > 0;
    if (needsEncryption && !config.security.masterKey)
      throw new ExternalAuthError('security.masterKey is required when OIDC is configured', 500);
    this.secretBox = config.security.masterKey ? new SecretBox(config.security.masterKey) : null;
  }

  providers(): { id: string; name: string }[] {
    return (this.config.authentication?.oidc ?? []).map(({ id, name }) => ({ id, name }));
  }

  async beginOidc(providerId: string, returnPath = '/'): Promise<URL> {
    const provider = this.provider(providerId);
    const configuration = await this.oidcConfiguration(provider);
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = randomBytes(32).toString('base64url');
    const redirectUri = new URL(`/auth/oidc/${provider.id}/callback`, this.config.server.publicUrl)
      .href;
    const safeReturnPath = /^\/(?!\/)[^\r\n]{0,1000}$/.test(returnPath) ? returnPath : '/';
    const encrypted = this.secretBox?.encrypt(codeVerifier, `oidc:${provider.id}:${state}`);
    if (!encrypted) throw new ExternalAuthError('OIDC flow encryption is unavailable', 500);
    const now = new Date();
    this.database.transaction(() => {
      this.database
        .prepare('DELETE FROM external_authentication_flows WHERE expires_at < ?')
        .run(now.toISOString());
      this.database
        .prepare(
          'INSERT INTO external_authentication_flows(state_hash, provider_id, code_verifier_encrypted, nonce, return_path, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          hashSecret(state),
          provider.id,
          encrypted,
          nonce,
          safeReturnPath,
          new Date(now.getTime() + 10 * 60_000).toISOString(),
          now.toISOString(),
        );
    })();
    const challenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    return oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: redirectUri,
      scope: provider.scopes.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });
  }

  async completeOidc(
    providerId: string,
    callbackUrl: URL,
    requestId?: string,
    ip?: string,
  ): Promise<{ user: AuthenticatedUser; returnPath: string }> {
    const provider = this.provider(providerId);
    const state = callbackUrl.searchParams.get('state');
    if (!state) throw new ExternalAuthError('OIDC state is missing');
    const flow = this.database
      .prepare(
        'DELETE FROM external_authentication_flows WHERE state_hash = ? AND provider_id = ? AND expires_at >= ? RETURNING code_verifier_encrypted AS codeVerifier, nonce, return_path AS returnPath',
      )
      .get(hashSecret(state), provider.id, new Date().toISOString()) as
      { codeVerifier: Buffer; nonce: string; returnPath: string } | undefined;
    if (!flow || !this.secretBox) throw new ExternalAuthError('OIDC flow is invalid or expired');
    const codeVerifier = this.secretBox.decrypt(flow.codeVerifier, `oidc:${provider.id}:${state}`);
    const tokens = await oidc.authorizationCodeGrant(
      await this.oidcConfiguration(provider),
      callbackUrl,
      { pkceCodeVerifier: codeVerifier, expectedState: state, expectedNonce: flow.nonce },
    );
    const claims = tokens.claims();
    if (!claims?.sub) throw new ExternalAuthError('OIDC provider returned no subject');
    const username = stringClaim(claims, provider.usernameClaim);
    const displayName = stringClaim(claims, provider.displayNameClaim) ?? username;
    if (!username || !displayName)
      throw new ExternalAuthError('OIDC provider returned no usable username');
    const email =
      typeof claims.email === 'string' && claims.email_verified === true ? claims.email : undefined;
    return {
      user: this.auth.loginExternal({
        providerId: `oidc:${provider.id}`,
        subject: claims.sub,
        username,
        displayName,
        ...(email ? { email } : {}),
        profile: safeProfile(claims),
        autoCreate: provider.autoCreate,
        ...(requestId ? { requestId } : {}),
        ...(ip ? { ip } : {}),
      }),
      returnPath: flow.returnPath,
    };
  }

  async loginLdap(
    usernameInput: string,
    password: string,
    requestId?: string,
    ip?: string,
  ): Promise<AuthenticatedUser> {
    const provider = this.config.authentication?.ldap;
    if (!provider?.enabled) throw new ExternalAuthError('LDAP authentication is disabled', 403);
    if (!password || password.length > 1024)
      throw new ExternalAuthError('LDAP credentials were not accepted', 401);
    const username = validateSlug(usernameInput, 'username');
    const directory = this.ldapClient(provider);
    let entry: Record<string, unknown> & { dn: string };
    try {
      await directory.bind(provider.bindDn, provider.bindPassword);
      const result = await directory.search(provider.baseDn, {
        scope: 'sub',
        filter: ldapUserFilter(provider.usernameAttribute, username),
        attributes: [
          provider.usernameAttribute,
          provider.displayNameAttribute,
          provider.emailAttribute,
        ],
        sizeLimit: 2,
        timeLimit: Math.ceil(provider.operationTimeoutMs / 1000),
      });
      if (result.searchEntries.length !== 1)
        throw new ExternalAuthError('LDAP credentials were not accepted', 401);
      entry = result.searchEntries[0] as Record<string, unknown> & { dn: string };
    } finally {
      await directory.unbind().catch(() => undefined);
    }
    const userClient = this.ldapClient(provider);
    try {
      await userClient.bind(entry.dn, password);
    } catch {
      throw new ExternalAuthError('LDAP credentials were not accepted', 401);
    } finally {
      await userClient.unbind().catch(() => undefined);
    }
    const displayName = attribute(entry, provider.displayNameAttribute) ?? username;
    const email = attribute(entry, provider.emailAttribute);
    return this.auth.loginExternal({
      providerId: 'ldap',
      subject: entry.dn,
      username,
      displayName,
      ...(email ? { email } : {}),
      profile: { dn: entry.dn },
      autoCreate: provider.autoCreate,
      ...(requestId ? { requestId } : {}),
      ...(ip ? { ip } : {}),
    });
  }

  private provider(id: string): OidcProvider {
    const provider = this.config.authentication?.oidc.find((item) => item.id === id);
    if (!provider) throw new ExternalAuthError('OIDC provider not found', 404);
    return provider;
  }
  private oidcConfiguration(provider: OidcProvider): Promise<oidc.Configuration> {
    let value = this.configurations.get(provider.id);
    if (!value) {
      value = oidc.discovery(
        new URL(provider.issuer),
        provider.clientId,
        provider.clientSecret,
        undefined,
        { timeout: 10 },
      );
      this.configurations.set(provider.id, value);
    }
    return value;
  }
  private ldapClient(
    provider: NonNullable<NonNullable<AppConfig['authentication']>['ldap']>,
  ): Client {
    return new Client({
      url: provider.url,
      connectTimeout: provider.connectTimeoutMs,
      timeout: provider.operationTimeoutMs,
      strictDN: true,
      tlsOptions: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    });
  }
}

function stringClaim(claims: Record<string, unknown>, key: string): string | undefined {
  const value = claims[key];
  return typeof value === 'string' && value.length <= 200 ? value : undefined;
}
function attribute(entry: Record<string, unknown>, key: string): string | undefined {
  const value = entry[key];
  if (typeof value === 'string') return value.slice(0, 500);
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].slice(0, 500);
  return undefined;
}
function safeProfile(claims: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    ['iss', 'sub', 'email_verified'].flatMap((key) => (key in claims ? [[key, claims[key]]] : [])),
  );
}
export function ldapUserFilter(attributeName: string, username: string): string {
  if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(attributeName))
    throw new ExternalAuthError('Invalid LDAP attribute configuration', 500);
  return `(${attributeName}=${Filter.escape(username)})`;
}
export class ExternalAuthError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}
