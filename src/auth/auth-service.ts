import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import type { AuditService } from '../audit/audit-service.js';
import type { AppConfig } from '../config/config.js';
import type { Database } from '../database/database.js';
import { validateSlug } from '../security/validation.js';
import { imageMetadata } from '../web/file-presentation.js';

export interface AuthenticatedUser {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
  status: 'active' | 'disabled';
  theme: 'light' | 'dark' | 'system';
  accent: string;
  pluginTheme: string | null;
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string | null;
  is_admin: number;
  status: 'active' | 'disabled';
  theme: 'light' | 'dark' | 'system';
  accent: string;
  plugin_theme: string | null;
}

export class AuthService {
  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  async register(input: {
    username: string;
    displayName: string;
    password: string;
    email?: string;
    inviteToken?: string;
    requestId?: string;
    ip?: string;
  }): Promise<AuthenticatedUser> {
    const username = validateSlug(input.username, 'username');
    if (input.displayName.trim().length < 1 || input.displayName.length > 100) {
      throw new AuthInputError('Display name must be between 1 and 100 characters');
    }
    validatePassword(input.password);
    const passwordHash = await argon2.hash(input.password, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    const userId = this.database.transaction(() => {
      const state = this.database
        .prepare('SELECT bootstrap_complete FROM application_state WHERE singleton = 1')
        .get() as { bootstrap_complete: number };
      const bootstrap = state.bootstrap_complete === 0;
      if (!bootstrap && this.config.registration.mode === 'closed')
        throw new RegistrationClosedError();
      if (!bootstrap && this.config.registration.mode === 'invite') {
        if (!input.inviteToken) throw new RegistrationClosedError();
        const digest = hashSecret(input.inviteToken);
        const invite = this.database
          .prepare(
            'SELECT id FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
          )
          .get(digest, new Date().toISOString()) as { id: number } | undefined;
        if (!invite) throw new RegistrationClosedError();
        this.database
          .prepare('UPDATE invites SET used_at = ? WHERE id = ?')
          .run(new Date().toISOString(), invite.id);
      }
      const now = new Date().toISOString();
      const result = this.database
        .prepare(
          `
          INSERT INTO users(username, display_name, email, password_hash, is_admin, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          username,
          input.displayName.trim(),
          input.email?.toLowerCase() ?? null,
          passwordHash,
          bootstrap ? 1 : 0,
          now,
        );
      const id = Number(result.lastInsertRowid);
      if (bootstrap) {
        const changed = this.database
          .prepare(
            'UPDATE application_state SET bootstrap_complete = 1 WHERE singleton = 1 AND bootstrap_complete = 0',
          )
          .run();
        if (changed.changes !== 1) throw new Error('Bootstrap race detected');
      }
      this.audit.record({
        actorUserId: id,
        action: bootstrap ? 'user.bootstrapCreated' : 'user.created',
        targetType: 'user',
        targetId: String(id),
        requestId: input.requestId,
        ip: input.ip,
      });
      return id;
    })();
    return this.getUser(userId);
  }

  async login(
    usernameInput: string,
    password: string,
    requestId?: string,
    ip?: string,
  ): Promise<AuthenticatedUser> {
    const username = usernameInput.normalize('NFKC').toLowerCase();
    const row = this.database.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      UserRow | undefined;
    const fallback =
      '$argon2id$v=19$m=65536,t=3,p=1$JHNhbHRzYWx0c2FsdHNhbHQk$cFZLTOl51IwfJpWHWl+uJiYgH4WXwrC99HMcXhwP7rc';
    const valid = await argon2.verify(row?.password_hash ?? fallback, password).catch(() => false);
    if (!row || !valid || row.status !== 'active') {
      this.audit.record({ action: 'auth.loginFailed', targetType: 'user', requestId, ip });
      throw new InvalidCredentialsError();
    }
    this.audit.record({
      actorUserId: row.id,
      action: 'auth.loginSucceeded',
      targetType: 'user',
      targetId: String(row.id),
      requestId,
      ip,
    });
    return mapUser(row);
  }

  loginReverseProxy(
    usernameInput: string,
    displayNameInput: string | undefined,
    autoCreate: boolean,
    requestId?: string,
    ip?: string,
  ): AuthenticatedUser {
    const username = validateSlug(usernameInput, 'username');
    let row = this.database.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      UserRow | undefined;
    if (!row && autoCreate) {
      const proposedDisplayName = displayNameInput?.trim();
      const displayName = proposedDisplayName?.length ? proposedDisplayName : username;
      if (displayName.length > 100) throw new AuthInputError('Display name is too long');
      const result = this.database
        .prepare(
          'INSERT INTO users(username, display_name, password_hash, status, is_admin, created_at) VALUES (?, ?, NULL, ?, 0, ?)',
        )
        .run(username, displayName, 'active', new Date().toISOString());
      row = this.database
        .prepare('SELECT * FROM users WHERE id = ?')
        .get(Number(result.lastInsertRowid)) as UserRow;
      this.audit.record({
        actorUserId: row.id,
        action: 'user.proxyCreated',
        targetType: 'user',
        targetId: String(row.id),
        requestId,
        ip,
      });
    }
    if (row?.status !== 'active') throw new InvalidCredentialsError();
    this.audit.record({
      actorUserId: row.id,
      action: 'login.proxySuccess',
      targetType: 'user',
      targetId: String(row.id),
      requestId,
      ip,
    });
    return mapUser(row);
  }

  loginExternal(input: {
    providerId: string;
    subject: string;
    username: string;
    displayName: string;
    email?: string;
    profile: Record<string, unknown>;
    autoCreate: boolean;
    requestId?: string;
    ip?: string;
  }): AuthenticatedUser {
    const existing = this.database
      .prepare(
        `SELECT u.* FROM external_identities e JOIN users u ON u.id = e.user_id WHERE e.provider_id = ? AND e.subject = ?`,
      )
      .get(input.providerId, input.subject) as UserRow | undefined;
    if (existing?.status === 'active') {
      this.audit.record({
        actorUserId: existing.id,
        action: 'login.externalSuccess',
        targetType: 'user',
        targetId: String(existing.id),
        requestId: input.requestId,
        ip: input.ip,
        metadata: { provider: input.providerId },
      });
      return mapUser(existing);
    }
    if (existing || !input.autoCreate) throw new InvalidCredentialsError();
    const username = validateSlug(input.username, 'username');
    const displayName = input.displayName.trim();
    if (!displayName || displayName.length > 100)
      throw new AuthInputError('Invalid external display name');
    const profileJson = JSON.stringify(input.profile).slice(0, 16_000);
    const userId = this.database.transaction(() => {
      const collision = this.database
        .prepare('SELECT id FROM users WHERE username = ? OR (? IS NOT NULL AND email = ?)')
        .get(username, input.email ?? null, input.email?.toLowerCase() ?? null);
      if (collision) throw new ExternalIdentityConflictError();
      const state = this.database
        .prepare('SELECT bootstrap_complete FROM application_state WHERE singleton = 1')
        .get() as { bootstrap_complete: number };
      const bootstrap = state.bootstrap_complete === 0;
      const now = new Date().toISOString();
      const result = this.database
        .prepare(
          'INSERT INTO users(username, display_name, email, password_hash, status, is_admin, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)',
        )
        .run(
          username,
          displayName,
          input.email?.toLowerCase() ?? null,
          'active',
          bootstrap ? 1 : 0,
          now,
        );
      const id = Number(result.lastInsertRowid);
      this.database
        .prepare(
          'INSERT INTO external_identities(user_id, provider_id, subject, profile_json, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(id, input.providerId, input.subject, profileJson, now);
      if (bootstrap) {
        const changed = this.database
          .prepare(
            'UPDATE application_state SET bootstrap_complete = 1 WHERE singleton = 1 AND bootstrap_complete = 0',
          )
          .run();
        if (changed.changes !== 1) throw new Error('Bootstrap race detected');
      }
      this.audit.record({
        actorUserId: id,
        action: bootstrap ? 'user.externalBootstrapCreated' : 'user.externalCreated',
        targetType: 'user',
        targetId: String(id),
        requestId: input.requestId,
        ip: input.ip,
        metadata: { provider: input.providerId },
      });
      return id;
    })();
    return this.getUser(userId);
  }

  createSession(
    userId: number,
    userAgent?: string,
  ): { token: string; csrfToken: string; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.security.sessionDays * 86_400_000);
    this.database
      .prepare(
        `
        INSERT INTO sessions(user_id, token_hash, csrf_secret, expires_at, created_at, last_seen_at, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        userId,
        hashSecret(token),
        Buffer.from(csrfToken, 'utf8'),
        expiresAt.toISOString(),
        now.toISOString(),
        now.toISOString(),
        userAgent?.slice(0, 500) ?? null,
      );
    return { token, csrfToken, expiresAt };
  }

  resolveSession(token: string | undefined): { user: AuthenticatedUser; csrfToken: string } | null {
    if (!token || token.length > 128) return null;
    const row = this.database
      .prepare(
        `
        SELECT u.*, s.id AS session_id, s.csrf_secret, s.last_seen_at FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'
      `,
      )
      .get(hashSecret(token), new Date().toISOString()) as
      (UserRow & { session_id: number; csrf_secret: Buffer; last_seen_at: string }) | undefined;
    if (!row) return null;
    const now = new Date();
    if (now.getTime() - new Date(row.last_seen_at).getTime() >= 5 * 60_000) {
      this.database
        .prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
        .run(now.toISOString(), row.session_id);
    }
    return { user: mapUser(row), csrfToken: row.csrf_secret.toString('utf8') };
  }

  verifyCsrf(expected: string, supplied: string | undefined): void {
    if (!supplied) throw new CsrfError();
    const left = Buffer.from(expected);
    const right = Buffer.from(supplied);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new CsrfError();
  }

  revokeSession(token: string | undefined): void {
    if (token)
      this.database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashSecret(token));
  }

  sessions(userId: number): {
    id: number;
    createdAt: string;
    lastSeenAt: string;
    expiresAt: string;
    userAgent: string | null;
  }[] {
    return this.database
      .prepare(
        'SELECT id, created_at AS createdAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt, user_agent AS userAgent FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC',
      )
      .all(userId) as {
      id: number;
      createdAt: string;
      lastSeenAt: string;
      expiresAt: string;
      userAgent: string | null;
    }[];
  }

  revokeUserSessions(userId: number, exceptToken?: string): void {
    if (exceptToken)
      this.database
        .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
        .run(userId, hashSecret(exceptToken));
    else this.database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    this.audit.record({
      actorUserId: userId,
      action: 'sessions.revoked',
      targetType: 'user',
      targetId: String(userId),
      metadata: { keptCurrent: Boolean(exceptToken) },
    });
  }

  appearance(userId: number): {
    theme: string;
    accent: string;
    uiFont: string;
    codeFont: string;
    reducedMotion: boolean;
    pluginTheme: string | null;
  } {
    const row = this.database
      .prepare(
        'SELECT theme, accent, ui_font AS uiFont, code_font AS codeFont, reduced_motion AS reducedMotion, plugin_theme AS pluginTheme FROM users WHERE id = ?',
      )
      .get(userId) as
      | {
          theme: string;
          accent: string;
          uiFont: string;
          codeFont: string;
          reducedMotion: number;
          pluginTheme: string | null;
        }
      | undefined;
    if (!row) throw new InvalidCredentialsError();
    return { ...row, reducedMotion: row.reducedMotion === 1 };
  }

  setAppearance(
    userId: number,
    input: {
      theme: string;
      accent: string;
      uiFont: string;
      codeFont: string;
      reducedMotion: boolean;
      pluginTheme: string | null;
    },
  ): void {
    if (
      !['light', 'dark', 'system'].includes(input.theme) ||
      !['violet', 'green', 'amber'].includes(input.accent) ||
      !['system', 'humanist'].includes(input.uiFont) ||
      !['system', 'mono'].includes(input.codeFont)
    )
      throw new AuthInputError('Invalid appearance preference');
    if (
      input.pluginTheme !== null &&
      !/^[a-z0-9.-]{3,100}:[a-z][a-z0-9.-]{1,63}$/.test(input.pluginTheme)
    )
      throw new AuthInputError('Invalid plugin theme preference');
    this.database
      .prepare(
        'UPDATE users SET theme = ?, accent = ?, ui_font = ?, code_font = ?, reduced_motion = ?, plugin_theme = ? WHERE id = ?',
      )
      .run(
        input.theme,
        input.accent,
        input.uiFont,
        input.codeFont,
        input.reducedMotion ? 1 : 0,
        input.pluginTheme,
        userId,
      );
  }

  getUser(id: number): AuthenticatedUser {
    const row = this.database.prepare('SELECT * FROM users WHERE id = ?').get(id) as
      UserRow | undefined;
    if (!row) throw new InvalidCredentialsError();
    return mapUser(row);
  }

  profile(userId: number): {
    displayName: string;
    email: string | null;
    emailPublic: boolean;
    hasAvatar: boolean;
  } {
    const row = this.database
      .prepare(
        'SELECT display_name AS displayName, email, email_public AS emailPublic, avatar IS NOT NULL AS hasAvatar FROM users WHERE id = ?',
      )
      .get(userId) as
      | { displayName: string; email: string | null; emailPublic: number; hasAvatar: number }
      | undefined;
    if (!row) throw new InvalidCredentialsError();
    return {
      displayName: row.displayName,
      email: row.email,
      emailPublic: row.emailPublic === 1,
      hasAvatar: row.hasAvatar === 1,
    };
  }

  updateProfile(
    userId: number,
    input: { displayName: string; email: string; emailPublic: boolean },
  ): void {
    const displayName = input.displayName.trim();
    const email = input.email.trim().toLowerCase();
    if (displayName.length < 1 || displayName.length > 100)
      throw new AuthInputError('Display name must be between 1 and 100 characters');
    if (email && !/^[^\s@]{1,200}@[^\s@]{1,200}$/.test(email))
      throw new AuthInputError('Email address is invalid');
    this.database
      .prepare('UPDATE users SET display_name = ?, email = ?, email_public = ? WHERE id = ?')
      .run(displayName, email || null, input.emailPublic ? 1 : 0, userId);
    this.audit.record({
      actorUserId: userId,
      action: 'user.profileChanged',
      targetType: 'user',
      targetId: String(userId),
      metadata: { emailPublic: input.emailPublic },
    });
  }

  setAvatar(userId: number, content: Buffer, mime: string): void {
    if (content.length < 16 || content.length > 512 * 1024 || !validAvatar(content, mime))
      throw new AuthInputError('Avatar must be a PNG, JPEG, GIF, or WebP image up to 512 KiB');
    this.database
      .prepare('UPDATE users SET avatar = ?, avatar_mime = ? WHERE id = ?')
      .run(content, mime, userId);
    this.audit.record({
      actorUserId: userId,
      action: 'user.avatarChanged',
      targetType: 'user',
      targetId: String(userId),
    });
  }

  removeAvatar(userId: number): void {
    this.database
      .prepare('UPDATE users SET avatar = NULL, avatar_mime = NULL WHERE id = ?')
      .run(userId);
    this.audit.record({
      actorUserId: userId,
      action: 'user.avatarRemoved',
      targetType: 'user',
      targetId: String(userId),
    });
  }
}

function validAvatar(content: Buffer, mime: string): boolean {
  const extension = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
  }[mime];
  if (!extension) return false;
  const metadata = imageMetadata(content, `avatar${extension}`);
  return Boolean(
    metadata &&
    metadata.width <= 4096 &&
    metadata.height <= 4096 &&
    metadata.width * metadata.height <= 16_000_000,
  );
}

export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function validatePassword(password: string): void {
  if (password.length < 12 || password.length > 1024) {
    throw new AuthInputError('Password must be between 12 and 1024 characters');
  }
}

function mapUser(row: UserRow): AuthenticatedUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    status: row.status,
    theme: row.theme,
    accent: row.accent,
    pluginTheme: row.plugin_theme,
  };
}

export class InvalidCredentialsError extends Error {
  readonly statusCode = 401;
}
export class RegistrationClosedError extends Error {
  readonly statusCode = 403;
}
export class AuthInputError extends Error {
  readonly statusCode = 400;
}
export class CsrfError extends Error {
  readonly statusCode = 403;
}
export class ExternalIdentityConflictError extends Error {
  readonly statusCode = 409;
  constructor() {
    super(
      'An account already uses that username or email; an administrator must link the identity explicitly',
    );
  }
}
