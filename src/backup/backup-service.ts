import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { AppConfig } from '../config/config.js';
import type { Database } from '../database/database.js';

interface ExternalRepositoryBackupReference {
  logicalName: string;
  storagePath: string;
  storageKind: string;
}

interface BackupManifest {
  formatVersion: 1;
  createdAt: string;
  applicationVersion: string;
  files: Record<string, { bytes: number; sha256: string }>;
  externalRepositories?: ExternalRepositoryBackupReference[];
}

export class BackupService {
  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly applicationVersion: string,
  ) {}

  async create(destinationInput: string, configFile: string): Promise<BackupManifest> {
    const destination = resolve(destinationInput);
    await ensureAbsent(destination);
    await mkdir(destination, { recursive: false, mode: 0o700 });
    await this.database.backup(join(destination, 'app.db'));
    await copyFile(configFile, join(destination, 'config.yml'));
    await safeCopyTree(this.config.storage.repositories, join(destination, 'repositories'));
    await safeCopyTree(this.config.storage.trash, join(destination, 'repository-trash'));
    await safeCopyTree(this.config.storage.lfs, join(destination, 'lfs'));
    await safeCopyTree(join(this.config.storage.data, 'plugins'), join(destination, 'plugins'));
    await safeCopyTree(
      join(this.config.storage.data, 'plugin-trash'),
      join(destination, 'plugin-trash'),
    );
    const files = await checksums(destination, new Set(['manifest.json']));
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
    const manifest: BackupManifest = {
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      applicationVersion: this.applicationVersion,
      files,
      externalRepositories,
    };
    await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    return manifest;
  }

  static async verify(sourceInput: string): Promise<BackupManifest> {
    const source = resolve(sourceInput);
    const parsed: unknown = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
    if (!isManifest(parsed)) throw new BackupError('Backup manifest is invalid');
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
    await BackupService.verify(source);
    const recoveryRoot = join(config.storage.data, `pre-restore-${String(Date.now())}`);
    await mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
    const targets = [
      {
        source: join(source, 'app.db'),
        target: config.database.path,
        recovery: join(recoveryRoot, 'app.db'),
      },
      {
        source: join(source, 'repositories'),
        target: config.storage.repositories,
        recovery: join(recoveryRoot, 'repositories'),
      },
      {
        source: join(source, 'lfs'),
        target: config.storage.lfs,
        recovery: join(recoveryRoot, 'lfs'),
      },
      {
        source: join(source, 'repository-trash'),
        target: config.storage.trash,
        recovery: join(recoveryRoot, 'repository-trash'),
      },
      {
        source: join(source, 'plugins'),
        target: join(config.storage.data, 'plugins'),
        recovery: join(recoveryRoot, 'plugins'),
      },
      {
        source: join(source, 'plugin-trash'),
        target: join(config.storage.data, 'plugin-trash'),
        recovery: join(recoveryRoot, 'plugin-trash'),
      },
    ];
    for (const item of targets) {
      if (!(await exists(item.source))) continue;
      await mkdir(dirname(item.target), { recursive: true, mode: 0o750 });
      if (await exists(item.target)) await rename(item.target, item.recovery);
      const info = await lstat(item.source);
      if (info.isDirectory()) await safeCopyTree(item.source, item.target);
      else await copyFile(item.source, item.target);
    }
    await copyFile(join(source, 'config.yml'), join(recoveryRoot, 'restored-config.yml'));
  }
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
    else if (entry.isFile()) await copyFile(sourcePath, destinationPath);
    else throw new BackupError(`Unsupported filesystem entry in backup: ${sourcePath}`);
  }
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

function isManifest(value: unknown): value is BackupManifest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    formatVersion?: unknown;
    createdAt?: unknown;
    applicationVersion?: unknown;
    files?: unknown;
    externalRepositories?: unknown;
  };
  return (
    candidate.formatVersion === 1 &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.applicationVersion === 'string' &&
    typeof candidate.files === 'object' &&
    candidate.files !== null &&
    !Array.isArray(candidate.files) &&
    (candidate.externalRepositories === undefined ||
      (Array.isArray(candidate.externalRepositories) &&
        candidate.externalRepositories.every(isExternalRepository)))
  );
}

function isExternalRepository(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const repository = value as Record<string, unknown>;
  return (
    typeof repository.logicalName === 'string' &&
    typeof repository.storagePath === 'string' &&
    typeof repository.storageKind === 'string'
  );
}

async function ensureAbsent(path: string): Promise<void> {
  if (await exists(path))
    throw new BackupError(`Backup destination already exists: ${basename(path)}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class BackupError extends Error {
  readonly statusCode = 409;
}
