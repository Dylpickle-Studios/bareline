import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from '../database/database.js';
import type { AuditService } from '../audit/audit-service.js';
import { hashSecret } from './auth-service.js';

export interface VerifiedToken {
  userId: number;
  scopes: readonly string[];
  /**
   * Repository this token is confined to, or null when it carries the full access of its user.
   * A confined token is rejected everywhere except that one repository, so it can be handed to
   * automation without exposing the rest of the account.
   */
  repositoryId: number | null;
}

export class TokenService {
  constructor(
    private readonly database: Database,
    private readonly audit?: AuditService,
  ) {}

  create(input: {
    userId: number;
    name: string;
    scopes: readonly string[];
    expiresAt?: Date;
    /** Confines the token to one repository. Callers must check the user may read it first. */
    repositoryId?: number;
  }): string {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 100) throw new TokenInputError('Token name is required');
    const allowedScopes = new Set([
      'repository:read',
      'repository:write',
      'api:read',
      'api:write',
      'api:admin',
      '*',
    ]);
    if (input.scopes.length < 1 || input.scopes.some((scope) => !allowedScopes.has(scope))) {
      throw new TokenInputError('Token scope is invalid');
    }
    // Administration is never repository-shaped, so the combination would be a misleading grant.
    if (input.repositoryId !== undefined && input.scopes.includes('api:admin')) {
      throw new TokenInputError('A repository token cannot carry the administration scope');
    }
    if (input.expiresAt && input.expiresAt <= new Date()) {
      throw new TokenInputError('Token expiration must be in the future');
    }
    const prefix = randomBytes(6).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const token = `ghp_${prefix}_${secret}`;
    this.database
      .prepare(
        `
        INSERT INTO tokens(user_id, kind, name, prefix, token_hash, scopes, expires_at, created_at, repository_id)
        VALUES (?, 'api', ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        input.userId,
        name,
        prefix,
        hashSecret(token),
        JSON.stringify([...new Set(input.scopes)].sort()),
        input.expiresAt?.toISOString() ?? null,
        new Date().toISOString(),
        input.repositoryId ?? null,
      );
    this.audit?.record({
      actorUserId: input.userId,
      action: 'token.created',
      targetType: 'user',
      targetId: String(input.userId),
      metadata: {
        scopes: [...new Set(input.scopes)].sort().join(','),
        ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
      },
    });
    return token;
  }

  list(userId: number): {
    id: number;
    name: string;
    prefix: string;
    scopes: string[];
    expiresAt: string | null;
    lastUsedAt: string | null;
    createdAt: string;
    repository: string | null;
  }[] {
    const rows = this.database
      .prepare(
        `
        SELECT t.id, t.name, t.prefix, t.scopes, t.expires_at, t.last_used_at, t.created_at,
          CASE WHEN t.repository_id IS NULL THEN NULL
            ELSE COALESCE(u.username, g.slug) || '/' || r.slug END AS repository
        FROM tokens t
        LEFT JOIN repositories r ON r.id = t.repository_id
        LEFT JOIN users u ON r.owner_type = 'user' AND r.owner_id = u.id
        LEFT JOIN groups g ON r.owner_type = 'group' AND r.owner_id = g.id
        WHERE t.user_id = ? AND t.kind = 'api' AND t.revoked_at IS NULL
        ORDER BY t.created_at DESC
      `,
      )
      .all(userId) as {
      id: number;
      name: string;
      prefix: string;
      scopes: string;
      expires_at: string | null;
      last_used_at: string | null;
      created_at: string;
      repository: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      scopes: JSON.parse(row.scopes) as string[],
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      repository: row.repository,
    }));
  }

  revoke(userId: number, tokenId: number): void {
    const result = this.database
      .prepare(
        'UPDATE tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      )
      .run(new Date().toISOString(), tokenId, userId);
    if (result.changes !== 1) throw new TokenInputError('Token not found');
    this.audit?.record({
      actorUserId: userId,
      action: 'token.revoked',
      targetType: 'token',
      targetId: String(tokenId),
    });
  }

  verify(token: string, requiredScope: string): VerifiedToken | null {
    const match = /^ghp_([A-Za-z0-9_-]{8})_[A-Za-z0-9_-]{43}$/.exec(token);
    if (!match?.[1]) return null;
    const row = this.database
      .prepare(
        `
        SELECT t.id, t.user_id, t.token_hash, t.scopes, t.repository_id FROM tokens t
        JOIN users u ON u.id = t.user_id
        WHERE t.prefix = ? AND t.kind = 'api' AND t.revoked_at IS NULL
          AND (t.expires_at IS NULL OR t.expires_at > ?) AND u.status = 'active'
      `,
      )
      .get(match[1], new Date().toISOString()) as
      | {
          id: number;
          user_id: number;
          token_hash: Buffer;
          scopes: string;
          repository_id: number | null;
        }
      | undefined;
    if (!row) return null;
    const expectedHash = hashSecret(token);
    if (
      row.token_hash.length !== expectedHash.length ||
      !timingSafeEqual(row.token_hash, expectedHash)
    )
      return null;
    const scopes = JSON.parse(row.scopes) as unknown;
    if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string')) return null;
    if (!scopes.includes(requiredScope) && !scopes.includes('*')) return null;
    this.database
      .prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?')
      .run(new Date().toISOString(), row.id);
    return { userId: row.user_id, scopes, repositoryId: row.repository_id };
  }
}

export class TokenInputError extends Error {
  readonly statusCode = 400;
}
