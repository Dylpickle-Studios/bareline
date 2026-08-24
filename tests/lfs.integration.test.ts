import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { LfsService } from '../src/lfs/lfs-service.js';
import { parseLfsPointer } from '../src/lfs/lfs-pointer.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

describe('local Git LFS', () => {
  it('negotiates, verifies, stores, links, and downloads objects', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const user = await new AuthService(database, config, audit).register({
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse battery staple',
    });
    const repositories = new RepositoryService(
      database,
      new GitRunner('git', 10_000, 16 * 1024 * 1024),
      config,
      audit,
    );
    const repository = await repositories.createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'example',
      visibility: 'private',
    });
    const content = Buffer.from('large object content');
    const objectId = createHash('sha256').update(content).digest('hex');
    const lfs = new LfsService(database, config);
    const uploadBatch = lfs.prepareBatch(repository, 'upload', [
      { oid: objectId, size: content.length },
    ]);
    expect(uploadBatch[0]).toHaveProperty('actions.upload');
    await lfs.upload(repository, objectId, Readable.from(content));
    const downloadBatch = lfs.prepareBatch(repository, 'download', [
      { oid: objectId, size: content.length },
    ]);
    expect(downloadBatch[0]).toHaveProperty('actions.download');
    const downloaded = await lfs.download(repository, objectId);
    const chunks: Buffer[] = [];
    for await (const chunk of downloaded.stream as AsyncIterable<Buffer>) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(content);
    expect(lfs.isAvailable(repository.id, objectId)).toBe(true);

    const pointer = Buffer.from(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${objectId}\nsize ${String(content.length)}\n`,
    );
    expect(parseLfsPointer(pointer)).toEqual({ objectId, size: content.length });
    expect(parseLfsPointer(Buffer.from('not a pointer'))).toBeNull();
    database.close();
  });
});
