import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import type { AppConfig } from '../config/config.js';
import type { Database } from '../database/database.js';

interface ExternalRepositoryBackupReference {
  logicalName: string;
  storagePath: string;
  storageKind: string;
}

interface BackupIntegrity {
  algorithm: 'hmac-sha256';
  value: string;
}

export interface BackupManifest {
  formatVersion: 1;
  createdAt: string;
  applicationVersion: string;
  consistency: {
    sqlite: 'online-backup';
    filesystem: 'caller-quiesced' | 'caller-must-quiesce';
  };
  files: Record<string, { bytes: number; sha256: string }>;
  externalRepositories?: ExternalRepositoryBackupReference[];
  integrity?: BackupIntegrity;
}

export type BackupQuiesceRelease = () => void | Promise<void>;

export interface BackupCreateOptions {
  /**
   * Stop writes to Git, LFS, plugin, and imported-repository roots before returning.
   * SQLite is captured with its online backup API; this hook covers the filesystem roots
   * which SQLite cannot snapshot. The release function is called after the final rename.
   */
  quiesce?: () => Promise<BackupQuiesceRelease>;
  /** Allows a scheduler to use one timestamp for naming, manifesting, and due calculations. */
  now?: () => Date;
}

export interface BackupVerifyOptions {
  /** The existing security.masterKey, used only to authenticate the manifest. */
  masterKey?: string;
  /** Reject legacy/unkeyed manifests instead of relying on their SHA-256 file list. */
  requireAuthenticated?: boolean;
}

interface RestoreTarget {
  name: string;
  source: string;
  target: string;
  kind: 'file' | 'directory';
  sidecars?: readonly string[];
}

interface StagedRestoreTarget extends RestoreTarget {
  staged: string;
}

interface MovedPath {
  target: string;
  recovery: string;
}

const backupLockName = '.backup.lock';

export class BackupService {
  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly applicationVersion: string,
  ) {}

  /**
   * Build a backup outside the requested destination and atomically rename it into place.
   * The process-local lock file prevents concurrent backup commands. Callers serving traffic
   * must also provide `quiesce`, or stop the service, because Git/LFS/plugin files are copied
   * recursively and do not have a SQLite-style online snapshot API.
   */
  async create(
    destinationInput: string,
    configFile: string,
    options: BackupCreateOptions = {},
  ): Promise<BackupManifest> {
    const destination = resolve(destinationInput);
    await ensureAbsent(destination);
    assertDestinationDoesNotOverlapSources(destination, [
      this.config.storage.repositories,
      this.config.storage.trash,
      this.config.storage.lfs,
      join(this.config.storage.data, 'plugins'),
      join(this.config.storage.data, 'plugin-trash'),
    ]);

    const parent = dirname(destination);
    await mkdir(parent, { recursive: true, mode: 0o750 });
    const lock = await acquireBackupLock(this.config.storage.data);
    let staging: string | undefined;
    let releaseQuiesce: BackupQuiesceRelease | undefined;
    try {
      staging = await mkdtemp(join(parent, `.${basename(destination)}.staging-`));
      releaseQuiesce = options.quiesce ? await options.quiesce() : undefined;

      await this.database.backup(join(staging, 'app.db'));
      await copyRegularFile(configFile, join(staging, 'config.yml'), 0o600);
      await safeCopyTree(this.config.storage.repositories, join(staging, 'repositories'));
      await safeCopyTree(this.config.storage.trash, join(staging, 'repository-trash'));
      await safeCopyTree(this.config.storage.lfs, join(staging, 'lfs'));
      await safeCopyTree(join(this.config.storage.data, 'plugins'), join(staging, 'plugins'));
      await safeCopyTree(
        join(this.config.storage.data, 'plugin-trash'),
        join(staging, 'plugin-trash'),
      );
      const files = await checksums(staging, new Set(['manifest.json']));
      const externalRepositories = this.database
        .prepare(
          `SELECT CASE r.owner_type WHEN 'user' THEN u.username ELSE g.slug END || '/' || r.slug AS logicalName,
                  r.storage_path AS storagePath, r.storage_kind AS storageKind
           FROM repositories r
           LEFT JOIN users u ON r.owner_type = 'user' AND r.owner_id = u.id
           LEFT JOIN groups g ON r.owner_type = 'group' AND r.owner_id = g.id
           WHERE r.storage_kind != 'hosted_bare' AND r.deleted_at IS NULL
           ORDER BY logicalName`,
        )
        .all() as ExternalRepositoryBackupReference[];
      const createdAt = options.now ? options.now() : new Date();
      if (Number.isNaN(createdAt.getTime()))
        throw new BackupError('Backup creation time is invalid');
      const manifest: BackupManifest = {
        formatVersion: 1,
        createdAt: createdAt.toISOString(),
        applicationVersion: this.applicationVersion,
        consistency: {
          sqlite: 'online-backup',
          filesystem: options.quiesce ? 'caller-quiesced' : 'caller-must-quiesce',
        },
        files: sortFiles(files),
        externalRepositories,
      };
      const key = decodeMasterKey(this.config.security.masterKey);
      if (key) {
        manifest.integrity = {
          algorithm: 'hmac-sha256',
          value: createManifestMac(manifest, key),
        };
      }
      const manifestPath = join(staging, 'manifest.json');
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await syncFile(manifestPath);
      await ensureAbsent(destination);
      await rename(staging, destination);
      staging = undefined;
      await syncDirectory(parent);
      return manifest;
    } catch (error) {
      if (staging) await rm(staging, { recursive: true, force: true });
      throw error;
    } finally {
      if (releaseQuiesce) await releaseQuiesce();
      await lock.release();
    }
  }

  static async verify(
    sourceInput: string,
    options: BackupVerifyOptions = {},
  ): Promise<BackupManifest> {
    const source = resolve(sourceInput);
    const parsed: unknown = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
    if (!isManifest(parsed)) throw new BackupError('Backup manifest is invalid');
    if (options.requireAuthenticated && !parsed.integrity)
      throw new BackupError('Backup manifest is not authenticated by security.masterKey');
    if (parsed.integrity) {
      const key = decodeMasterKey(options.masterKey);
      if (!key) {
        if (options.requireAuthenticated)
          throw new BackupError('An authenticated backup requires security.masterKey to verify');
      } else if (!safeEqual(parsed.integrity.value, createManifestMac(parsed, key))) {
        throw new BackupError('Backup manifest authentication failed');
      }
    }
    const actual = await checksums(source, new Set(['manifest.json']));
    const expectedPaths = Object.keys(parsed.files).sort();
    const actualPaths = Object.keys(actual).sort();
    if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
      throw new BackupError('Backup file list does not match its manifest');
    }
    for (const path of expectedPaths) {
      const expected = parsed.files[path];
      const found = actual[path];
      if (!expected || expected.bytes !== found?.bytes || expected.sha256 !== found.sha256) {
        throw new BackupError(`Backup checksum mismatch: ${path}`);
      }
    }
    return parsed;
  }

  static async restore(
    sourceInput: string,
    config: AppConfig,
    confirmation: boolean,
  ): Promise<void> {
    if (!confirmation) throw new BackupError('Restore requires --confirm-replace');
    const source = resolve(sourceInput);
    const verifyOptions: BackupVerifyOptions = {
      requireAuthenticated: Boolean(config.security.masterKey),
    };
    if (config.security.masterKey) verifyOptions.masterKey = config.security.masterKey;
    await BackupService.verify(source, verifyOptions);

    await assertRegularFile(join(source, 'app.db'), 'Backup is missing app.db');
    await assertRegularFile(join(source, 'config.yml'), 'Backup is missing config.yml');
    const targetDefinitions: RestoreTarget[] = [
      {
        name: 'app.db',
        source: join(source, 'app.db'),
        target: config.database.path,
        kind: 'file',
        sidecars: [`${config.database.path}-wal`, `${config.database.path}-shm`],
      },
      {
        name: 'repositories',
        source: join(source, 'repositories'),
        target: config.storage.repositories,
        kind: 'directory',
      },
      {
        name: 'lfs',
        source: join(source, 'lfs'),
        target: config.storage.lfs,
        kind: 'directory',
      },
      {
        name: 'repository-trash',
        source: join(source, 'repository-trash'),
        target: config.storage.trash,
        kind: 'directory',
      },
      {
        name: 'plugins',
        source: join(source, 'plugins'),
        target: join(config.storage.data, 'plugins'),
        kind: 'directory',
      },
      {
        name: 'plugin-trash',
        source: join(source, 'plugin-trash'),
        target: join(config.storage.data, 'plugin-trash'),
        kind: 'directory',
      },
    ];
    assertRestoreTargetLayout(targetDefinitions, config.storage.data);

    const lock = await acquireBackupLock(config.storage.data);
    try {
      const stageRoot = await mkdtemp(join(config.storage.data, '.restore-staging-'));
      let recoveryRoot: string | undefined;
      let stagedTargets: StagedRestoreTarget[] = [];
      const moved: MovedPath[] = [];
      const installed: string[] = [];
      try {
        stagedTargets = await stageRestoreTargets(targetDefinitions, stageRoot);
        for (const item of stagedTargets) {
          await ensureParentDirectory(item.target);
          await assertAtomicRenameCompatible(stageRoot, item.target);
          for (const sidecar of item.sidecars ?? []) {
            await assertSafePath(sidecar);
            await assertAtomicRenameCompatible(stageRoot, sidecar);
          }
        }

        recoveryRoot = join(
          config.storage.data,
          `pre-restore-${String(Date.now())}-${randomUUID()}`,
        );
        await mkdir(recoveryRoot, { recursive: false, mode: 0o700 });
        await copyRegularFile(
          join(source, 'config.yml'),
          join(recoveryRoot, 'restored-config.yml'),
          0o600,
        );

        for (const item of stagedTargets) {
          for (const [index, sidecar] of (item.sidecars ?? []).entries()) {
            if (!(await exists(sidecar))) continue;
            const recovery = join(recoveryRoot, `${item.name}.sidecar-${String(index)}`);
            await rename(sidecar, recovery);
            moved.push({ target: sidecar, recovery });
          }
          if (await exists(item.target)) {
            const recovery = join(recoveryRoot, item.name);
            await rename(item.target, recovery);
            moved.push({ target: item.target, recovery });
          }
          await rename(item.staged, item.target);
          installed.push(item.target);
        }
        await rm(stageRoot, { recursive: true, force: true });
      } catch (error) {
        let rollbackError: unknown;
        try {
          for (const target of installed.reverse())
            await rm(target, { recursive: true, force: true });
          for (const path of moved.reverse()) {
            if (await exists(path.recovery)) await rename(path.recovery, path.target);
          }
        } catch (rollbackFailure) {
          rollbackError = rollbackFailure;
        }
        await rm(stageRoot, { recursive: true, force: true });
        if (!rollbackError && recoveryRoot)
          await rm(recoveryRoot, { recursive: true, force: true });
        if (rollbackError) {
          throw new BackupError(
            `Restore failed and rollback could not be completed: ${formatError(rollbackError)}`,
          );
        }
        throw error;
      }
    } finally {
      await lock.release();
    }
  }

  /**
   * Verify that a backup can be materialized away from the live service. This is deliberately
   * narrower than restore(): it never reads the live configuration targets or swaps data.
   */
  static async verifyRestorable(
    sourceInput: string,
    options: BackupVerifyOptions = {},
  ): Promise<BackupManifest> {
    const source = resolve(sourceInput);
    const manifest = await BackupService.verify(source, options);
    await assertRegularFile(join(source, 'app.db'), 'Backup is missing app.db');
    await assertRegularFile(join(source, 'config.yml'), 'Backup is missing config.yml');
    for (const directory of ['repositories', 'repository-trash', 'lfs', 'plugins', 'plugin-trash'])
      await assertDirectory(join(source, directory), `Backup is missing ${directory}`);

    const staging = await mkdtemp(join(tmpdir(), 'bareline-restore-verify-'));
    try {
      await copyRegularFile(join(source, 'app.db'), join(staging, 'app.db'), 0o600);
      await copyRegularFile(join(source, 'config.yml'), join(staging, 'config.yml'), 0o600);
      for (const directory of [
        'repositories',
        'repository-trash',
        'lfs',
        'plugins',
        'plugin-trash',
      ])
        await safeCopyTree(join(source, directory), join(staging, directory));

      const database = new BetterSqlite3(join(staging, 'app.db'), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        const integrity = database.pragma('quick_check', { simple: true }) as string;
        if (integrity !== 'ok')
          throw new BackupError(`Restored SQLite integrity check failed: ${integrity}`);
        database.prepare('SELECT version FROM schema_migrations LIMIT 1').get();
      } finally {
        database.close();
      }
      return manifest;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

async function stageRestoreTargets(
  definitions: readonly RestoreTarget[],
  stageRoot: string,
): Promise<StagedRestoreTarget[]> {
  const staged: StagedRestoreTarget[] = [];
  for (const [index, definition] of definitions.entries()) {
    const info = await lstatIfExists(definition.source);
    if (!info) continue;
    if (definition.kind === 'file') {
      if (!info.isFile())
        throw new BackupError(`Backup entry is not a regular file: ${definition.name}`);
    } else if (!info.isDirectory()) {
      throw new BackupError(`Backup entry is not a directory: ${definition.name}`);
    }
    const stagedPath = join(stageRoot, `target-${String(index)}`);
    if (definition.kind === 'file') await copyRegularFile(definition.source, stagedPath);
    else await safeCopyTree(definition.source, stagedPath);
    staged.push({ ...definition, staged: stagedPath });
  }
  return staged;
}

async function safeCopyTree(source: string, destination: string): Promise<void> {
  if (!(await exists(source))) {
    await mkdir(destination, { recursive: true, mode: 0o750 });
    return;
  }
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new BackupError(`Refusing to back up symbolic link: ${source}`);
  if (!info.isDirectory()) throw new BackupError(`Expected directory: ${source}`);
  await mkdir(destination, { recursive: true, mode: info.mode & 0o777 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink())
      throw new BackupError(`Refusing to back up symbolic link: ${sourcePath}`);
    if (entry.isDirectory()) await safeCopyTree(sourcePath, destinationPath);
    else if (entry.isFile()) await copyRegularFile(sourcePath, destinationPath);
    else throw new BackupError(`Unsupported filesystem entry in backup: ${sourcePath}`);
  }
}

async function copyRegularFile(source: string, destination: string, mode?: number): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink() || !info.isFile())
    throw new BackupError(`Expected a regular file without symlinks: ${source}`);
  await mkdir(dirname(destination), { recursive: true, mode: 0o750 });
  await copyFile(source, destination);
  if (mode !== undefined) await chmod(destination, mode);
}

async function checksums(root: string, ignored: Set<string>): Promise<BackupManifest['files']> {
  const files: BackupManifest['files'] = {};
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const logical = relative(root, path).split('\\').join('/');
      if (ignored.has(logical)) continue;
      if (entry.isSymbolicLink())
        throw new BackupError(`Backup contains a symbolic link: ${logical}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const hash = createHash('sha256');
        let bytes = 0;
        for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
          bytes += chunk.length;
          hash.update(chunk);
        }
        files[logical] = { bytes, sha256: hash.digest('hex') };
      } else throw new BackupError(`Backup contains unsupported entry: ${logical}`);
    }
  }
  await walk(root);
  return files;
}

function sortFiles(files: BackupManifest['files']): BackupManifest['files'] {
  return Object.fromEntries(
    Object.entries(files).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function canonicalManifest(manifest: BackupManifest): string {
  const unsigned: Record<string, unknown> = {
    formatVersion: manifest.formatVersion,
    createdAt: manifest.createdAt,
    applicationVersion: manifest.applicationVersion,
    consistency: manifest.consistency,
    files: sortFiles(manifest.files),
  };
  if (manifest.externalRepositories !== undefined)
    unsigned.externalRepositories = manifest.externalRepositories;
  return JSON.stringify(unsigned);
}

function createManifestMac(manifest: BackupManifest, key: Buffer): string {
  return createHmac('sha256', key).update(canonicalManifest(manifest), 'utf8').digest('hex');
}

function decodeMasterKey(encoded: string | undefined): Buffer | undefined {
  if (!encoded) return undefined;
  const key = Buffer.from(encoded, 'base64url');
  if (key.length !== 32)
    throw new BackupError('Security master key must decode to exactly 32 bytes');
  return key;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function isManifest(value: unknown): value is BackupManifest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.formatVersion !== 1 ||
    typeof candidate.createdAt !== 'string' ||
    typeof candidate.applicationVersion !== 'string' ||
    !isFiles(candidate.files)
  )
    return false;
  if (candidate.consistency !== undefined && !isConsistency(candidate.consistency)) return false;
  if (candidate.integrity !== undefined && !isIntegrity(candidate.integrity)) return false;
  return (
    candidate.externalRepositories === undefined ||
    (Array.isArray(candidate.externalRepositories) &&
      candidate.externalRepositories.every(isExternalRepository))
  );
}

function isFiles(value: unknown): value is BackupManifest['files'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(([path, checksum]) => {
    if (!isSafeRelativePath(path) || typeof checksum !== 'object' || checksum === null)
      return false;
    const candidate = checksum as Record<string, unknown>;
    return (
      Number.isSafeInteger(candidate.bytes) &&
      (candidate.bytes as number) >= 0 &&
      typeof candidate.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(candidate.sha256)
    );
  });
}

function isConsistency(value: unknown): value is BackupManifest['consistency'] {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.sqlite === 'online-backup' &&
    (candidate.filesystem === 'caller-quiesced' || candidate.filesystem === 'caller-must-quiesce')
  );
}

function isIntegrity(value: unknown): value is BackupIntegrity {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.algorithm === 'hmac-sha256' &&
    typeof candidate.value === 'string' &&
    /^[a-f0-9]{64}$/.test(candidate.value)
  );
}

function isExternalRepository(value: unknown): value is ExternalRepositoryBackupReference {
  if (typeof value !== 'object' || value === null) return false;
  const repository = value as Record<string, unknown>;
  return (
    typeof repository.logicalName === 'string' &&
    typeof repository.storagePath === 'string' &&
    typeof repository.storageKind === 'string'
  );
}

function isSafeRelativePath(value: string): boolean {
  return (
    Boolean(value) &&
    !isAbsolute(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function assertDestinationDoesNotOverlapSources(
  destination: string,
  sources: readonly string[],
): void {
  for (const source of sources) {
    if (isWithin(source, destination))
      throw new BackupError(`Backup destination must not be inside managed source: ${source}`);
  }
}

function assertRestoreTargetLayout(targets: readonly RestoreTarget[], dataRoot: string): void {
  const paths = targets
    .flatMap((target) => [target.target, ...(target.sidecars ?? [])])
    .map((path) => resolve(path));
  const data = resolve(dataRoot);
  if (paths.some((path) => path === data || isWithin(path, data)))
    throw new BackupError('Restore targets must not replace or contain the storage data root');
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      const leftPath = paths[left];
      const rightPath = paths[right];
      if (!leftPath || !rightPath) continue;
      if (leftPath === rightPath || isWithin(leftPath, rightPath) || isWithin(rightPath, leftPath))
        throw new BackupError('Restore targets overlap and cannot be swapped transactionally');
    }
  }
}

function isWithin(root: string, child: string): boolean {
  const path = relative(resolve(root), resolve(child));
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function assertSafePath(path: string): Promise<void> {
  let current = resolve(path);
  for (;;) {
    const info = await lstatIfExists(current);
    if (info?.isSymbolicLink())
      throw new BackupError(`Refusing to operate through symbolic link: ${current}`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function assertAtomicRenameCompatible(stageRoot: string, target: string): Promise<void> {
  await assertSafePath(target);
  const parentInfo = await stat(dirname(resolve(target)));
  const stageInfo = await stat(stageRoot);
  if (parentInfo.dev !== stageInfo.dev)
    throw new BackupError(
      `Restore target is on a different filesystem and cannot be swapped atomically: ${target}`,
    );
  const targetInfo = await lstatIfExists(target);
  if (targetInfo && targetInfo.dev !== stageInfo.dev)
    throw new BackupError(
      `Restore target is on a different filesystem and cannot be recovered atomically: ${target}`,
    );
}

async function ensureParentDirectory(path: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o750 });
  await assertSafePath(path);
}

async function assertRegularFile(path: string, message: string): Promise<void> {
  const info = await lstatIfExists(path);
  if (!info || info.isSymbolicLink() || !info.isFile()) throw new BackupError(message);
}

async function assertDirectory(path: string, message: string): Promise<void> {
  const info = await lstatIfExists(path);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) throw new BackupError(message);
}

async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function ensureAbsent(path: string): Promise<void> {
  if (await exists(path))
    throw new BackupError(`Backup destination already exists: ${basename(path)}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function acquireBackupLock(dataRoot: string): Promise<{ release: () => Promise<void> }> {
  await mkdir(dataRoot, { recursive: true, mode: 0o750 });
  const path = join(dataRoot, backupLockName);
  const token = randomUUID();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`, 'utf8');
  } catch (error) {
    if (handle) await handle.close();
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new BackupError('Another backup is already in progress');
    throw error;
  }
  const acquiredHandle = handle;
  return {
    release: async () => {
      await acquiredHandle.close();
      await rm(path, { force: true });
    },
  };
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown rollback error';
}

export class BackupError extends Error {
  readonly statusCode = 409;
}
