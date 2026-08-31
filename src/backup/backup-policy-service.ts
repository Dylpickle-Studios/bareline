import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { AppConfig } from '../config/config.js';
import type { Database } from '../database/database.js';
import { BackupError, BackupService, type BackupManifest } from './backup-service.js';

export const MIN_BACKUP_INTERVAL_HOURS = 1;
export const MAX_BACKUP_INTERVAL_HOURS = 168;
export const MIN_BACKUP_RETENTION = 1;
export const MAX_BACKUP_RETENTION = 365;

export interface BackupPolicy {
  output: string;
  intervalHours: number;
  retain: number;
}

export interface BackupPolicyStatus {
  due: boolean;
  latestCreatedAt?: string;
  nextDueAt?: string;
  retained: number;
  invalid: string[];
}

export interface BackupPolicyRunOptions {
  dryRun?: boolean;
  force?: boolean;
}

export interface BackupPolicyRunResult extends BackupPolicyStatus {
  created?: string;
  removed: string[];
}

interface StoredBackup {
  path: string;
  createdAt: Date;
  manifest: BackupManifest;
}

/**
 * A deliberately stateless backup policy for a scheduler such as systemd or cron. The interval
 * and retention must be passed on every invocation so a hidden database setting cannot silently
 * weaken a deployment's recovery objectives.
 */
export class BackupPolicyService {
  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly applicationVersion: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async status(policy: BackupPolicy): Promise<BackupPolicyStatus> {
    this.validatePolicy(policy);
    const scanned = await this.scan(policy);
    return statusFor(scanned.backups, scanned.invalid, policy, this.now());
  }

  async run(
    policy: BackupPolicy,
    configFile: string,
    options: BackupPolicyRunOptions = {},
  ): Promise<BackupPolicyRunResult> {
    this.validatePolicy(policy);
    const scanned = await this.scan(policy);
    const status = statusFor(scanned.backups, scanned.invalid, policy, this.now());
    const prune = backupsToPrune(
      scanned.backups,
      policy.retain,
      Boolean(status.due || options.force),
    );
    if (!status.due && !options.force)
      return { ...status, removed: options.dryRun ? prune.map((backup) => backup.path) : [] };

    const output = resolve(policy.output);
    const destination = join(output, backupDirectoryName(this.now()));
    if (options.dryRun)
      return { ...status, created: destination, removed: prune.map((backup) => backup.path) };

    await assertSafeOutputPath(output, true);
    await mkdir(output, { recursive: true, mode: 0o750 });
    await assertSafeOutputPath(output);
    const service = new BackupService(this.database, this.config, this.applicationVersion);
    await service.create(destination, configFile, { now: this.now });
    await BackupService.verifyRestorable(destination, verifyOptions(this.config));

    const refreshed = await this.scan(policy);
    const removed = backupsToPrune(refreshed.backups, policy.retain, false).map(
      (backup) => backup.path,
    );
    for (const path of removed) await rm(path, { recursive: true, force: false });
    const finalStatus = statusFor(
      refreshed.backups.filter((backup) => !removed.includes(backup.path)),
      refreshed.invalid,
      policy,
      this.now(),
    );
    return { ...finalStatus, created: destination, removed };
  }

  private async scan(
    policy: BackupPolicy,
  ): Promise<{ backups: StoredBackup[]; invalid: string[] }> {
    const output = resolve(policy.output);
    try {
      await assertSafeOutputPath(output);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { backups: [], invalid: [] };
      throw error;
    }
    const backups: StoredBackup[] = [];
    const invalid: string[] = [];
    for (const entry of await readdir(output, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !isBackupDirectoryName(entry.name))
        continue;
      const path = join(output, entry.name);
      try {
        const manifest = await BackupService.verify(path, verifyOptions(this.config));
        const createdAt = new Date(manifest.createdAt);
        if (Number.isNaN(createdAt.getTime()))
          throw new BackupError('Backup manifest createdAt is invalid');
        backups.push({ path, createdAt, manifest });
      } catch {
        invalid.push(path);
      }
    }
    backups.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    return { backups, invalid: invalid.sort() };
  }

  private validatePolicy(policy: BackupPolicy): void {
    validatePolicy(policy);
    if (isWithin(this.config.storage.data, policy.output))
      throw new BackupError(
        '--output must be outside storage.data and on a separate backup volume',
      );
  }
}

function validatePolicy(policy: BackupPolicy): void {
  if (
    !Number.isInteger(policy.intervalHours) ||
    policy.intervalHours < MIN_BACKUP_INTERVAL_HOURS ||
    policy.intervalHours > MAX_BACKUP_INTERVAL_HOURS
  )
    throw new BackupError(
      `--interval-hours must be between ${String(MIN_BACKUP_INTERVAL_HOURS)} and ${String(MAX_BACKUP_INTERVAL_HOURS)}`,
    );
  if (
    !Number.isInteger(policy.retain) ||
    policy.retain < MIN_BACKUP_RETENTION ||
    policy.retain > MAX_BACKUP_RETENTION
  )
    throw new BackupError(
      `--retain must be between ${String(MIN_BACKUP_RETENTION)} and ${String(MAX_BACKUP_RETENTION)}`,
    );
  if (!policy.output.trim()) throw new BackupError('--output is required');
}

function statusFor(
  backups: StoredBackup[],
  invalid: string[],
  policy: BackupPolicy,
  now: Date,
): BackupPolicyStatus {
  const latest = backups[0];
  const nextDue = latest
    ? new Date(latest.createdAt.getTime() + policy.intervalHours * 60 * 60 * 1000)
    : undefined;
  return {
    due: !nextDue || now.getTime() >= nextDue.getTime(),
    ...(latest ? { latestCreatedAt: latest.manifest.createdAt } : {}),
    ...(nextDue ? { nextDueAt: nextDue.toISOString() } : {}),
    retained: backups.length,
    invalid,
  };
}

function backupsToPrune(
  backups: StoredBackup[],
  retain: number,
  includeNewBackup: boolean,
): StoredBackup[] {
  const keepExisting = includeNewBackup ? retain - 1 : retain;
  return backups.slice(Math.max(0, keepExisting));
}

function backupDirectoryName(now: Date): string {
  return `bareline-${now.toISOString().replace(/[-:.]/g, '')}-${randomUUID()}`;
}

function isBackupDirectoryName(name: string): boolean {
  return /^bareline-\d{8}T\d{6}\d{3}Z-[0-9a-f-]{36}$/.test(name);
}

function verifyOptions(config: AppConfig) {
  return config.security.masterKey
    ? { masterKey: config.security.masterKey, requireAuthenticated: true }
    : { requireAuthenticated: true };
}

function isWithin(root: string, child: string): boolean {
  const path = relative(resolve(root), resolve(child));
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
}

async function assertSafeOutputPath(path: string, allowMissing = false): Promise<void> {
  const output = resolve(path);
  let current = output;
  let outputMissing = false;
  for (;;) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new BackupError(
          `Backup policy output must not traverse symbolic links: ${basename(current)}`,
        );
      if (current === output && !info.isDirectory())
        throw new BackupError(
          `Backup policy output must be a directory without symlinks: ${basename(path)}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (current === output) outputMissing = true;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (outputMissing && !allowMissing) {
    const error = new Error(
      `Backup policy output does not exist: ${output}`,
    ) as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    throw error;
  }
}
