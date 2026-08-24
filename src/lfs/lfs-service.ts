import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AppConfig } from '../config/config.js';
import type { Database } from '../database/database.js';
import type { Repository } from '../repositories/repository-types.js';

export interface LfsBatchObject {
  oid: string;
  size: number;
}

export class LfsService {
  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
  ) {}

  prepareBatch(
    repository: Repository,
    operation: 'download' | 'upload',
    objects: LfsBatchObject[],
  ) {
    if (objects.length > 100) throw new LfsInputError('LFS batch contains too many objects', 413);
    return objects.map((object) => {
      validateLfsObject(object.oid, object.size, this.config.limits.lfsObjectBytes);
      const existing = this.database
        .prepare('SELECT size FROM lfs_objects WHERE object_id = ?')
        .get(object.oid) as { size: number } | undefined;
      const linked = existing
        ? (this.database
            .prepare(
              'SELECT 1 FROM repository_lfs_objects WHERE repository_id = ? AND object_id = ?',
            )
            .get(repository.id, object.oid) as { 1: number } | undefined)
        : undefined;
      if (operation === 'download') {
        if (!existing || !linked) {
          return {
            oid: object.oid,
            size: object.size,
            error: { code: 404, message: 'Object not found' },
          };
        }
        return {
          oid: object.oid,
          size: existing.size,
          actions: { download: this.action(repository, object.oid) },
        };
      }
      if (existing) {
        if (existing.size !== object.size)
          throw new LfsInputError('LFS object size does not match existing object', 409);
        this.database
          .prepare(
            'INSERT OR IGNORE INTO repository_lfs_objects(repository_id, object_id) VALUES (?, ?)',
          )
          .run(repository.id, object.oid);
        return { oid: object.oid, size: object.size };
      }
      this.database
        .prepare(
          `
          INSERT INTO lfs_uploads(repository_id, object_id, expected_size, expires_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(repository_id, object_id) DO UPDATE SET
            expected_size = excluded.expected_size, expires_at = excluded.expires_at
        `,
        )
        .run(
          repository.id,
          object.oid,
          object.size,
          new Date(Date.now() + 60 * 60_000).toISOString(),
        );
      return {
        oid: object.oid,
        size: object.size,
        actions: { upload: this.action(repository, object.oid) },
      };
    });
  }

  async upload(repository: Repository, objectId: string, body: Readable): Promise<void> {
    validateOid(objectId);
    const pending = this.database
      .prepare(
        `
        SELECT expected_size FROM lfs_uploads
        WHERE repository_id = ? AND object_id = ? AND expires_at > ?
      `,
      )
      .get(repository.id, objectId, new Date().toISOString()) as
      { expected_size: number } | undefined;
    if (!pending) throw new LfsInputError('LFS upload was not negotiated or has expired', 409);
    const directory = join(this.config.storage.lfs, objectId.slice(0, 2));
    await mkdir(directory, { recursive: true, mode: 0o750 });
    const finalPath = join(directory, objectId);
    const temporaryPath = `${finalPath}.${String(process.pid)}.${String(Date.now())}.tmp`;
    const verifier = new HashAndLimit(pending.expected_size, this.config.limits.lfsObjectBytes);
    try {
      await pipeline(
        body,
        verifier,
        createWriteStream(temporaryPath, { flags: 'wx', mode: 0o640 }),
      );
      if (verifier.bytes !== pending.expected_size || verifier.digest() !== objectId) {
        throw new LfsInputError('LFS object digest or size did not match the batch request', 422);
      }
      await rename(temporaryPath, finalPath);
      this.database.transaction(() => {
        this.database
          .prepare(
            'INSERT OR IGNORE INTO lfs_objects(object_id, size, storage_path, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(objectId, pending.expected_size, finalPath, new Date().toISOString());
        this.database
          .prepare(
            'INSERT OR IGNORE INTO repository_lfs_objects(repository_id, object_id) VALUES (?, ?)',
          )
          .run(repository.id, objectId);
        this.database
          .prepare('DELETE FROM lfs_uploads WHERE repository_id = ? AND object_id = ?')
          .run(repository.id, objectId);
      })();
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async download(repository: Repository, objectId: string) {
    validateOid(objectId);
    const row = this.database
      .prepare(
        `
        SELECT o.size, o.storage_path FROM lfs_objects o
        JOIN repository_lfs_objects r ON r.object_id = o.object_id
        WHERE r.repository_id = ? AND o.object_id = ?
      `,
      )
      .get(repository.id, objectId) as { size: number; storage_path: string } | undefined;
    if (!row) throw new LfsInputError('LFS object not found', 404);
    const info = await stat(row.storage_path);
    if (!info.isFile() || info.size !== row.size)
      throw new LfsInputError('LFS object is unavailable', 503);
    return { stream: createReadStream(row.storage_path), size: row.size };
  }

  isAvailable(repositoryId: number, objectId: string): boolean {
    return Boolean(
      this.database
        .prepare('SELECT 1 FROM repository_lfs_objects WHERE repository_id = ? AND object_id = ?')
        .get(repositoryId, objectId),
    );
  }

  private action(repository: Repository, objectId: string) {
    return {
      href: `${this.config.server.publicUrl.replace(/\/$/, '')}/${repository.ownerSlug}/${repository.slug}.git/info/lfs/objects/${objectId}`,
      expires_in: 3600,
    };
  }
}

class HashAndLimit extends Transform {
  readonly hash = createHash('sha256');
  bytes = 0;

  constructor(
    private readonly expected: number,
    private readonly hardLimit: number,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.expected || this.bytes > this.hardLimit) {
      callback(new LfsInputError('LFS object exceeded its negotiated size', 413));
      return;
    }
    this.hash.update(chunk);
    callback(null, chunk);
  }

  digest(): string {
    return this.hash.digest('hex');
  }
}

function validateLfsObject(objectId: string, size: number, limit: number): void {
  validateOid(objectId);
  if (!Number.isSafeInteger(size) || size < 0 || size > limit) {
    throw new LfsInputError('LFS object size is invalid or exceeds the configured limit', 413);
  }
}

function validateOid(objectId: string): void {
  if (!/^[0-9a-f]{64}$/.test(objectId)) throw new LfsInputError('Invalid LFS object ID', 400);
}

export class LfsInputError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}
