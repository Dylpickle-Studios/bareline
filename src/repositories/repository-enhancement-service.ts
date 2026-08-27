import type { AuditService } from '../audit/audit-service.js';
import type { Database } from '../database/database.js';
import type { GitRunner } from '../git/git-runner.js';
import { inspectKey, SshKeyInputError } from '../ssh/ssh-key-service.js';
import { OutboundPolicy, OutboundPolicyError } from '../security/outbound-policy.js';
import { validateRef } from '../security/validation.js';
import type { RepositoryService } from './repository-service.js';
import type { Repository } from './repository-types.js';

export interface RepositoryPolicy {
  refPattern: string;
  blockForcePush: boolean;
  blockDeletion: boolean;
  requireSignedCommits: boolean;
  commitMessagePrefix: string | null;
}

export class RepositoryEnhancementService {
  constructor(
    private readonly database: Database,
    private readonly git: GitRunner,
    private readonly repositories: RepositoryService,
    private readonly audit: AuditService,
    private readonly allowedMirrorHosts: readonly string[] = [],
    private readonly outboundPolicy = new OutboundPolicy(),
  ) {}

  policies(repositoryId: number): RepositoryPolicy[] {
    const rows = this.database
      .prepare(
        `SELECT ref_pattern, block_force_push, block_deletion,
      require_signed_commits, commit_message_pattern FROM repository_policies
      WHERE repository_id = ? ORDER BY ref_pattern`,
      )
      .all(repositoryId) as {
      ref_pattern: string;
      block_force_push: number;
      block_deletion: number;
      require_signed_commits: number;
      commit_message_pattern: string | null;
    }[];
    return rows.map((row) => ({
      refPattern: row.ref_pattern,
      blockForcePush: Boolean(row.block_force_push),
      blockDeletion: Boolean(row.block_deletion),
      requireSignedCommits: Boolean(row.require_signed_commits),
      commitMessagePrefix: row.commit_message_pattern,
    }));
  }

  async setPolicy(
    repository: Repository,
    actorUserId: number,
    input: RepositoryPolicy,
  ): Promise<void> {
    this.repositories.require(repository, actorUserId, 'admin');
    const pattern = validatePolicyPattern(input.refPattern);
    const trimmedPrefix = input.commitMessagePrefix?.trim();
    const prefix = trimmedPrefix === '' ? null : (trimmedPrefix ?? null);
    if (prefix && prefix.length > 200)
      throw new RepositoryEnhancementError('Commit message prefix is too long');
    this.database
      .prepare(
        `INSERT INTO repository_policies(repository_id, ref_pattern,
      block_force_push, block_deletion, require_signed_commits, commit_message_pattern, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repository_id, ref_pattern) DO UPDATE SET
      block_force_push=excluded.block_force_push, block_deletion=excluded.block_deletion,
      require_signed_commits=excluded.require_signed_commits, commit_message_pattern=excluded.commit_message_pattern`,
      )
      .run(
        repository.id,
        pattern,
        Number(input.blockForcePush),
        Number(input.blockDeletion),
        Number(input.requireSignedCommits),
        prefix,
        actorUserId,
        new Date().toISOString(),
      );
    await this.syncReceivePolicy(repository);
    this.audit.record({
      actorUserId,
      action: 'repository.policyChanged',
      targetType: 'repository',
      targetId: String(repository.id),
      metadata: { refPattern: pattern },
    });
    this.recordActivity(repository.id, actorUserId, 'repository.policyChanged', pattern);
  }

  async removePolicy(
    repository: Repository,
    actorUserId: number,
    patternInput: string,
  ): Promise<void> {
    this.repositories.require(repository, actorUserId, 'admin');
    const pattern = validatePolicyPattern(patternInput);
    this.database
      .prepare('DELETE FROM repository_policies WHERE repository_id = ? AND ref_pattern = ?')
      .run(repository.id, pattern);
    await this.syncReceivePolicy(repository);
    this.audit.record({
      actorUserId,
      action: 'repository.policyRemoved',
      targetType: 'repository',
      targetId: String(repository.id),
      metadata: { refPattern: pattern },
    });
    this.recordActivity(repository.id, actorUserId, 'repository.policyRemoved', pattern);
  }

  assertWebCommit(repositoryId: number, branchInput: string, message: string): void {
    const branch = validateRef(branchInput);
    for (const policy of this.policies(repositoryId).filter((item) =>
      refMatches(item.refPattern, branch),
    )) {
      if (policy.requireSignedCommits)
        throw new RepositoryEnhancementError(
          'This branch requires signed commits; use signed Git transport',
        );
      if (policy.commitMessagePrefix && !message.startsWith(policy.commitMessagePrefix))
        throw new RepositoryEnhancementError(
          `Commit messages on this branch must start with “${policy.commitMessagePrefix}”`,
        );
    }
  }

  assertBranchDeletion(repositoryId: number, branchInput: string): void {
    const branch = validateRef(branchInput);
    if (
      this.policies(repositoryId).some(
        (item) => item.blockDeletion && refMatches(item.refPattern, branch),
      )
    )
      throw new RepositoryEnhancementError('This branch is protected from deletion', 409);
  }

  assertTransportWritable(repositoryId: number): void {
    if (
      this.policies(repositoryId).some(
        (policy) => policy.requireSignedCommits || policy.commitMessagePrefix,
      )
    )
      throw new RepositoryEnhancementError(
        'Git transport pushes are disabled while signed-commit or message-prefix policies are active; use an authorized web commit or remove the policy',
        403,
      );
  }

  async addDeployKey(
    repository: Repository,
    actorUserId: number,
    nameInput: string,
    publicKeyInput: string,
  ) {
    this.repositories.require(repository, actorUserId, 'admin');
    const name = nameInput.trim();
    const publicKey = publicKeyInput.trim();
    if (!name || name.length > 100 || publicKey.length > 16_384 || /[\r\n\0]/.test(publicKey))
      throw new RepositoryEnhancementError('Invalid deploy key');
    const inspected = await inspectKey(publicKey);
    if (inspected.type === 'RSA' && inspected.bits < 3072)
      throw new SshKeyInputError('RSA keys must contain at least 3072 bits');
    const result = this.database
      .prepare(
        `INSERT INTO repository_deploy_keys(repository_id, name,
      fingerprint, public_key, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repository.id,
        name,
        inspected.fingerprint,
        publicKey,
        actorUserId,
        new Date().toISOString(),
      );
    this.audit.record({
      actorUserId,
      action: 'deployKey.created',
      targetType: 'repository',
      targetId: String(repository.id),
      metadata: { fingerprint: inspected.fingerprint },
    });
    return Number(result.lastInsertRowid);
  }

  deployKeys(repositoryId: number) {
    return this.database
      .prepare(
        `SELECT id, name, fingerprint, created_at AS createdAt,
      last_used_at AS lastUsedAt FROM repository_deploy_keys WHERE repository_id = ? ORDER BY created_at DESC`,
      )
      .all(repositoryId) as {
      id: number;
      name: string;
      fingerprint: string;
      createdAt: string;
      lastUsedAt: string | null;
    }[];
  }

  removeDeployKey(repository: Repository, actorUserId: number, id: number): void {
    this.repositories.require(repository, actorUserId, 'admin');
    const result = this.database
      .prepare('DELETE FROM repository_deploy_keys WHERE id = ? AND repository_id = ?')
      .run(id, repository.id);
    if (result.changes !== 1) throw new RepositoryEnhancementError('Deploy key not found', 404);
    this.audit.record({
      actorUserId,
      action: 'deployKey.removed',
      targetType: 'repository',
      targetId: String(repository.id),
      metadata: { keyId: id },
    });
  }

  setTemplate(repository: Repository, actorUserId: number, enabled: boolean): void {
    this.repositories.require(repository, actorUserId, 'admin');
    if (enabled)
      this.database
        .prepare(
          `INSERT INTO repository_templates(repository_id, enabled_by, enabled_at)
      VALUES (?, ?, ?) ON CONFLICT(repository_id) DO NOTHING`,
        )
        .run(repository.id, actorUserId, new Date().toISOString());
    else
      this.database
        .prepare('DELETE FROM repository_templates WHERE repository_id = ?')
        .run(repository.id);
    this.audit.record({
      actorUserId,
      action: enabled ? 'repository.templateEnabled' : 'repository.templateDisabled',
      targetType: 'repository',
      targetId: String(repository.id),
    });
  }

  isTemplate(repositoryId: number): boolean {
    return Boolean(
      this.database
        .prepare('SELECT 1 FROM repository_templates WHERE repository_id = ?')
        .get(repositoryId),
    );
  }

  configureMirror(
    repository: Repository,
    actorUserId: number,
    input: { direction: 'pull' | 'push'; remoteUrl: string; intervalMinutes: number },
  ): void {
    this.repositories.require(repository, actorUserId, 'admin');
    const url = validateMirrorUrl(input.remoteUrl, this.allowedMirrorHosts, this.outboundPolicy);
    const interval = Math.min(Math.max(Math.trunc(input.intervalMinutes), 5), 10_080);
    const now = new Date();
    this.database
      .prepare(
        `INSERT INTO repository_mirrors(repository_id, direction, remote_url, interval_minutes,
      next_run_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repository_id) DO UPDATE SET direction=excluded.direction, remote_url=excluded.remote_url,
      interval_minutes=excluded.interval_minutes, enabled=1, next_run_at=excluded.next_run_at, last_error=NULL`,
      )
      .run(
        repository.id,
        input.direction,
        url,
        interval,
        now.toISOString(),
        actorUserId,
        now.toISOString(),
      );
    this.audit.record({
      actorUserId,
      action: 'repository.mirrorConfigured',
      targetType: 'repository',
      targetId: String(repository.id),
      metadata: { direction: input.direction },
    });
  }

  mirror(repositoryId: number) {
    return this.database
      .prepare(
        `SELECT direction, remote_url AS remoteUrl, interval_minutes AS intervalMinutes,
      enabled, last_run_at AS lastRunAt, last_success_at AS lastSuccessAt, last_error AS lastError,
      next_run_at AS nextRunAt FROM repository_mirrors WHERE repository_id=?`,
      )
      .get(repositoryId) as
      | {
          direction: 'pull' | 'push';
          remoteUrl: string;
          intervalMinutes: number;
          enabled: number;
          lastRunAt: string | null;
          lastSuccessAt: string | null;
          lastError: string | null;
          nextRunAt: string;
        }
      | undefined;
  }

  async runMirror(repository: Repository, actorUserId: number | null): Promise<void> {
    if (actorUserId !== null) this.repositories.require(repository, actorUserId, 'admin');
    const mirror = this.mirror(repository.id);
    if (!mirror) throw new RepositoryEnhancementError('Mirror is not configured', 404);
    const path = await this.repositories.storagePath(repository);
    const now = new Date();
    try {
      const remote = await this.outboundPolicy.assertSafeGitTarget(mirror.remoteUrl, {
        allowedHosts: this.allowedMirrorHosts,
      });
      if (mirror.direction === 'pull')
        await this.git.run([
          '-c',
          'http.followRedirects=false',
          '--git-dir',
          path,
          'fetch',
          '--prune',
          remote,
          '+refs/*:refs/*',
        ]);
      else
        await this.git.run([
          '-c',
          'http.followRedirects=false',
          '--git-dir',
          path,
          'push',
          '--mirror',
          remote,
        ]);
      this.database
        .prepare(
          `UPDATE repository_mirrors SET last_run_at=?, last_success_at=?, last_error=NULL,
        next_run_at=? WHERE repository_id=?`,
        )
        .run(
          now.toISOString(),
          now.toISOString(),
          new Date(now.getTime() + mirror.intervalMinutes * 60_000).toISOString(),
          repository.id,
        );
      this.recordActivity(repository.id, actorUserId, 'repository.mirrored', undefined, {
        direction: mirror.direction,
      });
    } catch (error) {
      const safeError =
        error instanceof Error
          ? error.message.replaceAll(mirror.remoteUrl, '[remote]').slice(0, 500)
          : 'Mirror failed';
      this.database
        .prepare(
          `UPDATE repository_mirrors SET last_run_at=?, last_error=?, next_run_at=? WHERE repository_id=?`,
        )
        .run(
          now.toISOString(),
          safeError,
          new Date(now.getTime() + mirror.intervalMinutes * 60_000).toISOString(),
          repository.id,
        );
      throw new RepositoryEnhancementError('Repository mirror failed', 502);
    }
  }

  async runDueMirrors(): Promise<{ attempted: number; failed: number }> {
    const rows = this.database
      .prepare(
        `SELECT repository_id AS id FROM repository_mirrors
      WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at LIMIT 50`,
      )
      .all(new Date().toISOString()) as { id: number }[];
    let failed = 0;
    for (const row of rows) {
      try {
        await this.runMirror(this.repositories.getById(row.id), null);
      } catch {
        failed += 1;
      }
    }
    return { attempted: rows.length, failed };
  }

  removeMirror(repository: Repository, actorUserId: number): void {
    this.repositories.require(repository, actorUserId, 'admin');
    this.database
      .prepare('DELETE FROM repository_mirrors WHERE repository_id=?')
      .run(repository.id);
    this.audit.record({
      actorUserId,
      action: 'repository.mirrorRemoved',
      targetType: 'repository',
      targetId: String(repository.id),
    });
  }

  addTrustedSigner(
    actorUserId: number,
    input: {
      fingerprint: string;
      identity: string;
      keyType: 'openpgp' | 'ssh';
      publicKey?: string;
    },
  ): void {
    const admin = this.database
      .prepare("SELECT 1 FROM users WHERE id=? AND status='active' AND is_admin=1")
      .get(actorUserId);
    if (!admin) throw new RepositoryEnhancementError('Not found', 404);
    const fingerprint = input.fingerprint.trim().toUpperCase();
    const identity = input.identity.trim();
    if (!/^[A-Z0-9:+/=._-]{16,200}$/.test(fingerprint) || !identity || identity.length > 200)
      throw new RepositoryEnhancementError('Invalid signer identity');
    this.database
      .prepare(
        `INSERT INTO trusted_signers(fingerprint, identity, key_type, public_key, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(fingerprint) DO UPDATE SET identity=excluded.identity,
      key_type=excluded.key_type, public_key=excluded.public_key, revoked_at=NULL`,
      )
      .run(
        fingerprint,
        identity,
        input.keyType,
        input.publicKey?.trim() ?? null,
        actorUserId,
        new Date().toISOString(),
      );
    this.audit.record({
      actorUserId,
      action: 'trustedSigner.added',
      targetType: 'trustedSigner',
      targetId: fingerprint,
    });
  }

  trustedIdentity(fingerprint: string | null | undefined): string | null {
    if (!fingerprint) return null;
    const row = this.database
      .prepare(
        'SELECT identity FROM trusted_signers WHERE fingerprint=? COLLATE NOCASE AND revoked_at IS NULL',
      )
      .get(fingerprint) as { identity: string } | undefined;
    return row?.identity ?? null;
  }

  revokeTrustedSigner(actorUserId: number, fingerprintInput: string): void {
    const admin = this.database
      .prepare("SELECT 1 FROM users WHERE id=? AND status='active' AND is_admin=1")
      .get(actorUserId);
    if (!admin) throw new RepositoryEnhancementError('Not found', 404);
    const fingerprint = fingerprintInput.trim().toUpperCase();
    const result = this.database
      .prepare(
        'UPDATE trusted_signers SET revoked_at=? WHERE fingerprint=? COLLATE NOCASE AND revoked_at IS NULL',
      )
      .run(new Date().toISOString(), fingerprint);
    if (result.changes !== 1) throw new RepositoryEnhancementError('Trusted signer not found', 404);
    this.audit.record({
      actorUserId,
      action: 'trustedSigner.revoked',
      targetType: 'trustedSigner',
      targetId: fingerprint,
    });
  }

  recordActivity(
    repositoryId: number,
    actorUserId: number | null,
    action: string,
    refName?: string,
    metadata: Record<string, unknown> = {},
  ): void {
    this.database
      .prepare(
        `INSERT INTO repository_activity(repository_id, actor_user_id, action, ref_name, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repositoryId,
        actorUserId,
        action.slice(0, 100),
        refName ?? null,
        JSON.stringify(metadata).slice(0, 8192),
        new Date().toISOString(),
      );
  }

  activity(repositoryId: number, limit = 50) {
    return this.database
      .prepare(
        `SELECT ra.id, ra.action, ra.ref_name AS refName, ra.metadata_json AS metadataJson,
      ra.created_at AS createdAt, u.username FROM repository_activity ra LEFT JOIN users u ON u.id=ra.actor_user_id
      WHERE repository_id=? ORDER BY ra.created_at DESC, ra.id DESC LIMIT ?`,
      )
      .all(repositoryId, Math.min(Math.max(limit, 1), 100));
  }

  pin(userId: number, repositoryId: number, enabled: boolean): void {
    if (enabled)
      this.database
        .prepare(
          `INSERT INTO user_pinned_repositories(user_id, repository_id, created_at)
      VALUES (?, ?, ?) ON CONFLICT(user_id, repository_id) DO NOTHING`,
        )
        .run(userId, repositoryId, new Date().toISOString());
    else
      this.database
        .prepare('DELETE FROM user_pinned_repositories WHERE user_id=? AND repository_id=?')
        .run(userId, repositoryId);
  }

  touchRecent(userId: number, repositoryId: number): void {
    this.database
      .prepare(
        `INSERT INTO user_recent_repositories(user_id, repository_id, viewed_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id, repository_id) DO UPDATE SET viewed_at=excluded.viewed_at`,
      )
      .run(userId, repositoryId, new Date().toISOString());
    this.database
      .prepare(
        `DELETE FROM user_recent_repositories WHERE user_id=? AND repository_id NOT IN
      (SELECT repository_id FROM user_recent_repositories WHERE user_id=? ORDER BY viewed_at DESC LIMIT 20)`,
      )
      .run(userId, userId);
  }

  pinnedIds(userId: number): number[] {
    return (
      this.database
        .prepare(
          'SELECT repository_id AS id FROM user_pinned_repositories WHERE user_id=? ORDER BY position, created_at',
        )
        .all(userId) as { id: number }[]
    ).map((row) => row.id);
  }

  recentIds(userId: number): number[] {
    return (
      this.database
        .prepare(
          'SELECT repository_id AS id FROM user_recent_repositories WHERE user_id=? ORDER BY viewed_at DESC LIMIT 10',
        )
        .all(userId) as { id: number }[]
    ).map((row) => row.id);
  }

  private async syncReceivePolicy(repository: Repository): Promise<void> {
    const policies = this.policies(repository.id);
    const path = await this.repositories.storagePath(repository);
    await this.git.run([
      '--git-dir',
      path,
      'config',
      'receive.denyNonFastForwards',
      policies.some((p) => p.blockForcePush) ? 'true' : 'false',
    ]);
    await this.git.run([
      '--git-dir',
      path,
      'config',
      'receive.denyDeletes',
      policies.some((p) => p.blockDeletion) ? 'true' : 'false',
    ]);
  }
}

function validatePolicyPattern(value: string): string {
  const pattern = value.trim();
  if (
    !/^[A-Za-z0-9._/-]+(?:\*)?$/.test(pattern) ||
    pattern.startsWith('-') ||
    pattern.includes('..') ||
    pattern.length > 255
  )
    throw new RepositoryEnhancementError(
      'Ref pattern must be a branch name or a prefix ending in *',
    );
  if (!pattern.endsWith('*')) validateRef(pattern);
  return pattern;
}

function refMatches(pattern: string, ref: string): boolean {
  return pattern.endsWith('*') ? ref.startsWith(pattern.slice(0, -1)) : pattern === ref;
}

function validateMirrorUrl(
  input: string,
  allowedHosts: readonly string[],
  outboundPolicy: OutboundPolicy,
): string {
  try {
    return outboundPolicy.validateGitTarget(input, { allowedHosts });
  } catch (error) {
    if (error instanceof OutboundPolicyError) throw new RepositoryEnhancementError(error.message);
    throw new RepositoryEnhancementError('Invalid mirror URL');
  }
}

export class RepositoryEnhancementError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}
