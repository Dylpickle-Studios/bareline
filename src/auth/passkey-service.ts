import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { product } from '../app/metadata.js';
import type { AuditService } from '../audit/audit-service.js';
import type { AppConfig } from '../config/config.js';
import type { Database } from '../database/database.js';

export class PasskeyService {
  private readonly origin: string;
  private readonly rpId: string;
  constructor(
    private readonly database: Database,
    config: AppConfig,
    private readonly audit: AuditService,
  ) {
    const publicUrl = new URL(config.server.publicUrl);
    this.origin = publicUrl.origin;
    this.rpId = publicUrl.hostname;
  }

  async registrationOptions(userId: number): Promise<unknown> {
    const user = this.database
      .prepare('SELECT username, display_name FROM users WHERE id = ? AND status = ?')
      .get(userId, 'active') as { username: string; display_name: string } | undefined;
    if (!user) throw new PasskeyError('Active user not found');
    const credentials = this.credentials(userId);
    const options = await generateRegistrationOptions({
      rpName: product.name,
      rpID: this.rpId,
      userName: user.username,
      userDisplayName: user.display_name,
      userID: Uint8Array.from(Buffer.from(String(userId))),
      attestationType: 'none',
      timeout: 60_000,
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      excludeCredentials: credentials.map((item) => ({
        id: item.id.toString('base64url'),
        transports: parseTransports(item.transports),
      })),
    });
    this.storeChallenge(options.challenge, 'passkey-registration', userId);
    return options;
  }

  async register(
    userId: number,
    challenge: string,
    name: string,
    response: RegistrationResponseJSON,
  ): Promise<void> {
    this.consumeChallenge(challenge, 'passkey-registration', userId);
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpId,
      requireUserVerification: true,
    });
    if (!verification.verified) throw new PasskeyError('Passkey verification failed');
    const credential = verification.registrationInfo.credential;
    this.database
      .prepare(
        'INSERT INTO passkeys(id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        Buffer.from(credential.id, 'base64url'),
        userId,
        Buffer.from(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports ?? []),
        name.trim().slice(0, 100) || 'Passkey',
        new Date().toISOString(),
      );
    this.audit.record({
      actorUserId: userId,
      action: 'passkey.created',
      targetType: 'user',
      targetId: String(userId),
    });
  }

  async authenticationOptions(username?: string): Promise<unknown> {
    const user = username
      ? (this.database
          .prepare('SELECT id FROM users WHERE username = ? AND status = ?')
          .get(username, 'active') as { id: number } | undefined)
      : undefined;
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      timeout: 60_000,
      userVerification: 'required',
      allowCredentials: (user ? this.credentials(user.id) : []).map((item) => ({
        id: item.id.toString('base64url'),
        transports: parseTransports(item.transports),
      })),
    });
    this.storeChallenge(options.challenge, 'passkey-authentication', user?.id ?? null);
    return options;
  }

  list(
    userId: number,
  ): { id: string; name: string; createdAt: string; lastUsedAt: string | null }[] {
    const rows = this.database
      .prepare(
        'SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM passkeys WHERE user_id = ? ORDER BY created_at',
      )
      .all(userId) as { id: Buffer; name: string; createdAt: string; lastUsedAt: string | null }[];
    return rows.map((row) => ({ ...row, id: row.id.toString('base64url') }));
  }

  rename(userId: number, id: string, name: string): void {
    const safeName = name.trim();
    if (!safeName || safeName.length > 100) throw new PasskeyError('Invalid passkey name');
    const result = this.database
      .prepare('UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?')
      .run(safeName, Buffer.from(id, 'base64url'), userId);
    if (result.changes !== 1) throw new PasskeyError('Passkey not found');
    this.audit.record({
      actorUserId: userId,
      action: 'passkey.renamed',
      targetType: 'user',
      targetId: String(userId),
    });
  }

  remove(userId: number, id: string): void {
    const result = this.database
      .prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?')
      .run(Buffer.from(id, 'base64url'), userId);
    if (result.changes !== 1) throw new PasskeyError('Passkey not found');
    this.audit.record({
      actorUserId: userId,
      action: 'passkey.removed',
      targetType: 'user',
      targetId: String(userId),
    });
  }

  async authenticate(challenge: string, response: AuthenticationResponseJSON): Promise<number> {
    const challengeRow = this.consumeChallenge(challenge, 'passkey-authentication');
    const credentialId = Buffer.from(response.id, 'base64url');
    const row = this.database
      .prepare(
        "SELECT p.user_id, p.public_key, p.counter, p.transports FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND u.status = 'active'",
      )
      .get(credentialId) as
      { user_id: number; public_key: Buffer; counter: number; transports: string } | undefined;
    if (!row || (challengeRow.userId !== null && challengeRow.userId !== row.user_id))
      throw new PasskeyError('Passkey authentication failed');
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpId,
      requireUserVerification: true,
      credential: {
        id: response.id,
        publicKey: Uint8Array.from(row.public_key),
        counter: row.counter,
        transports: parseTransports(row.transports),
      },
    });
    if (!verification.verified) throw new PasskeyError('Passkey authentication failed');
    this.database
      .prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?')
      .run(verification.authenticationInfo.newCounter, new Date().toISOString(), credentialId);
    this.audit.record({
      actorUserId: row.user_id,
      action: 'login.passkeySuccess',
      targetType: 'user',
      targetId: String(row.user_id),
    });
    return row.user_id;
  }

  private credentials(userId: number): { id: Buffer; transports: string }[] {
    return this.database
      .prepare('SELECT id, transports FROM passkeys WHERE user_id = ?')
      .all(userId) as { id: Buffer; transports: string }[];
  }
  private storeChallenge(challenge: string, purpose: string, userId: number | null): void {
    const now = new Date();
    this.database.transaction(() => {
      this.database
        .prepare('DELETE FROM authentication_challenges WHERE expires_at < ?')
        .run(now.toISOString());
      this.database
        .prepare(
          'INSERT INTO authentication_challenges(challenge, purpose, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          challenge,
          purpose,
          userId,
          new Date(now.getTime() + 300_000).toISOString(),
          now.toISOString(),
        );
    })();
  }
  private consumeChallenge(
    challenge: string,
    purpose: string,
    userId?: number,
  ): { userId: number | null } {
    const row = this.database
      .prepare(
        'DELETE FROM authentication_challenges WHERE challenge = ? AND purpose = ? AND expires_at >= ? RETURNING user_id AS userId',
      )
      .get(challenge, purpose, new Date().toISOString()) as { userId: number | null } | undefined;
    if (!row || (userId !== undefined && row.userId !== userId))
      throw new PasskeyError('Authentication challenge is invalid or expired');
    return row;
  }
}

function parseTransports(
  value: string,
): ('ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb')[] {
  return JSON.parse(value) as (
    'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb'
  )[];
}
export class PasskeyError extends Error {
  readonly statusCode = 400;
}
