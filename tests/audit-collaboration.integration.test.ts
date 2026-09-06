import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { migrations } from '../src/database/migrations.js';
import { temporaryConfig } from './helpers.js';
import { createApp } from '../src/app/create-app.js';
import { LfsService } from '../src/lfs/lfs-service.js';
import { TokenService } from '../src/auth/token-service.js';
import { BackupService } from '../src/backup/backup-service.js';
import { auditFixture } from './audit-fixture.js';

describe('audit collaboration regressions', () => {
  it('restores legacy backups without retaining destination wiki or release data', async () => {
    const config = temporaryConfig();
    config.security.masterKey = Buffer.alloc(32, 7).toString('base64url');
    const database = new BetterSqlite3(config.database.path);
    try {
      database.exec(`CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL) STRICT`);
      for (const migration of migrations.filter((entry) => entry.version < 20)) {
        database.exec(migration.sql);
        database
          .prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)')
          .run(
            migration.version,
            migration.name,
            createHash('sha256').update(migration.sql).digest('hex'),
            new Date().toISOString(),
          );
      }
      const configFile = join(config.storage.data, 'config.yml');
      await writeFile(configFile, 'test: true');
      const backup = join(config.storage.data, 'legacy');
      await new BackupService(database, config, '1.1.0').create(backup, configFile);
      for (const name of ['wikis', 'releases']) {
        await rm(join(backup, name), { recursive: true });
      }
      await expect(
        BackupService.verifyRestorable(backup, {
          masterKey: config.security.masterKey,
        }),
      ).resolves.toBeDefined();
      const target = temporaryConfig();
      target.security.masterKey = config.security.masterKey;
      try {
        for (const name of ['wikis', 'releases']) {
          await mkdir(join(target.storage.data, name));
          await writeFile(join(target.storage.data, name, 'stale'), 'stale');
        }
        await BackupService.restore(backup, target, true);
        for (const name of ['wikis', 'releases']) {
          await expect(readFile(join(target.storage.data, name, 'stale'))).rejects.toMatchObject({
            code: 'ENOENT',
          });
        }
      } finally {
        await rm(target.storage.data, { recursive: true, force: true });
      }
    } finally {
      database.close();
      await rm(config.storage.data, { recursive: true, force: true });
    }
  });

  it('refuses incomplete collaboration backups and overlapping auxiliary backup destinations', async () => {
    const f = await auditFixture();
    try {
      const configFile = join(f.config.storage.data, 'config.yml');
      await writeFile(configFile, 'test: true');
      const service = new BackupService(f.database, f.config, '1.2.0');
      for (const root of ['wikis', 'releases']) {
        await expect(
          service.create(join(f.config.storage.data, root, 'backup'), configFile),
        ).rejects.toThrow(/managed source/);
      }
      const backup = join(f.config.storage.data, 'incomplete');
      await service.create(backup, configFile);
      // Empty directories are not represented in the file checksum list.
      await rm(join(backup, 'wikis'), { recursive: true });
      await expect(
        BackupService.verify(backup, { masterKey: f.config.security.masterKey ?? '' }),
      ).resolves.toBeDefined();
      await expect(
        BackupService.verifyRestorable(backup, { masterKey: f.config.security.masterKey ?? '' }),
      ).rejects.toThrow(/Incomplete backup/);
      await expect(BackupService.restore(backup, f.config, true)).rejects.toThrow(
        /Incomplete backup/,
      );
      expect(f.repositories.getById(f.repository.id).slug).toBe('audit');
    } finally {
      await f.cleanup();
    }
  });

  it('requires possession of LFS bytes before linking an object from a private repository', async () => {
    const f = await auditFixture();
    const app = await createApp(f.config);
    try {
      const otherRepo = await f.repositories.createForUser({
        actorUserId: f.other.id,
        ownerUserId: f.other.id,
        slug: 'other',
        visibility: 'private',
      });
      const lfs = new LfsService(f.database, f.config);
      const content = Buffer.from('private object content');
      const oid = createHash('sha256').update(content).digest('hex');
      lfs.prepareBatch(f.repository, 'upload', [{ oid, size: content.length }]);
      await lfs.upload(f.repository, oid, Readable.from(content));
      const token = new TokenService(f.database).create({
        userId: f.other.id,
        name: 'other',
        scopes: ['repository:read', 'repository:write'],
      });
      const headers = { authorization: `Basic ${Buffer.from(`bob:${token}`).toString('base64')}` };
      expect(f.repositories.permission(f.repository, f.other.id)).toBe('none');
      const prefix = '/bob/other.git/info/lfs/objects';
      const batch = await app.inject({
        method: 'POST',
        url: `${prefix}/batch`,
        headers,
        payload: { operation: 'upload', objects: [{ oid, size: content.length }] },
      });
      expect(batch.statusCode).toBe(200);
      expect(
        batch.json<{ objects: { actions: { upload: unknown } }[] }>().objects[0]?.actions.upload,
      ).toBeDefined();
      expect((await app.inject({ url: `${prefix}/${oid}`, headers })).statusCode).toBe(404);
      expect(lfs.isAvailable(otherRepo.id, oid)).toBe(false);
      const upload = await app.inject({
        method: 'PUT',
        url: `${prefix}/${oid}`,
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        payload: content,
      });
      expect(upload.statusCode).toBe(200);
      expect((await app.inject({ url: `${prefix}/${oid}`, headers })).rawPayload).toEqual(content);
    } finally {
      await app.close();
      await f.cleanup();
    }
  });

  it('uses actual tags and lists only current wiki pages with their latest edit', async () => {
    const f = await auditFixture();
    try {
      const release = await f.releases.create({
        repository: f.repository,
        actorUserId: f.user.id,
        tagName: 'main',
        name: 'Release',
        body: '',
      });
      expect(await f.repositories.resolveTag(f.repository, 'main')).toBe(release.objectId);
      const write = (content: string) =>
        f.wikis.writePage({
          repository: f.repository,
          actorUserId: f.user.id,
          page: 'Home',
          content,
          message: content,
        });
      await write('initial');
      await write('latest');
      expect(await f.wikis.listPages(f.repository)).toEqual([
        expect.objectContaining({ name: 'Home', subject: 'latest' }),
      ]);
      await f.wikis.deletePage({
        repository: f.repository,
        actorUserId: f.user.id,
        page: 'Home',
        message: 'remove',
      });
      expect(await f.wikis.listPages(f.repository)).toEqual([]);
      await write('recreated');
      expect(await f.wikis.listPages(f.repository)).toEqual([
        expect.objectContaining({ name: 'Home', subject: 'recreated' }),
      ]);
    } finally {
      await f.cleanup();
    }
  });

  it('rejects every collaboration write after archive, even with a stale repository record', async () => {
    const f = await auditFixture();
    try {
      const r = f.repository,
        id = f.user.id;
      const issue = f.issues.create(r, id, { title: 'Issue', body: '' });
      const label = f.issues.createLabel(r, id, 'bug', 'ffffff');
      const comment = f.issues.addComment(r, id, issue.number, 'comment');
      await f.releases.create({
        repository: r,
        actorUserId: id,
        tagName: 'v1',
        name: '',
        body: '',
      });
      await f.wikis.writePage({
        repository: r,
        actorUserId: id,
        page: 'Home',
        content: 'home',
        message: 'home',
      });
      f.enhancements.setArchived(r, id, true);
      for (const action of [
        () => f.issues.create(r, id, { title: 'new', body: '' }),
        () => f.issues.updateDetails(r, id, issue.number, { title: 'changed' }),
        () => f.issues.setStatus(r, id, issue.number, 'closed'),
        () => f.issues.assign(r, id, issue.number, id),
        () => f.issues.setLabels(r, id, issue.number, [label.id]),
        () => f.issues.addComment(r, id, issue.number, 'new'),
        () => f.issues.updateComment(r, id, issue.number, comment.id, 'changed'),
        () => {
          f.issues.removeComment(r, id, issue.number, comment.id);
        },
        () => f.issues.createLabel(r, id, 'new', 'ffffff'),
        () => {
          f.issues.removeLabel(r, id, label.id);
        },
      ])
        expect(action).toThrow(/archived/);
      for (const action of [
        () =>
          f.wikis.writePage({
            repository: r,
            actorUserId: id,
            page: 'Home',
            content: 'changed',
            message: 'changed',
          }),
        () =>
          f.wikis.deletePage({ repository: r, actorUserId: id, page: 'Home', message: 'delete' }),
        () =>
          f.releases.create({ repository: r, actorUserId: id, tagName: 'v2', name: '', body: '' }),
        () => f.releases.delete(r, id, 'v1'),
        () =>
          f.releases.addAsset({
            repository: r,
            actorUserId: id,
            tagName: 'v1',
            filename: 'x',
            contentType: '',
            content: Buffer.from('x'),
          }),
      ])
        await expect(action()).rejects.toThrow(/archived/);
      f.enhancements.setArchived(f.repositories.getById(r.id), id, false);
      expect(f.issues.create(r, id, { title: 'active again', body: '' }).title).toBe(
        'active again',
      );
    } finally {
      await f.cleanup();
    }
  });

  it('restores wiki history and release bytes into an empty root and purges auxiliary data with retries', async () => {
    const f = await auditFixture();
    try {
      const r = f.repository;
      for (const content of ['initial', 'latest'])
        await f.wikis.writePage({
          repository: r,
          actorUserId: f.user.id,
          page: 'Home',
          content,
          message: content,
        });
      await f.releases.create({
        repository: r,
        actorUserId: f.user.id,
        tagName: 'v1',
        name: '',
        body: '',
      });
      const asset = await f.releases.addAsset({
        repository: r,
        actorUserId: f.user.id,
        tagName: 'v1',
        filename: 'asset',
        contentType: '',
        content: Buffer.from('saved'),
      });
      const configFile = join(f.config.storage.data, 'config.yml');
      const backup = join(f.config.storage.data, 'backup');
      await writeFile(configFile, 'test: true');
      await new BackupService(f.database, f.config, '1.2.0').create(backup, configFile);
      await expect(
        BackupService.verifyRestorable(backup, { masterKey: f.config.security.masterKey ?? '' }),
      ).resolves.toBeDefined();
      // Restore only into a separate target; the live source stays available for the purge test.
      const data = join(f.config.storage.data, 'restored');
      const restoredConfig = {
        ...f.config,
        storage: {
          ...f.config.storage,
          data,
          repositories: join(data, 'repositories'),
          lfs: join(data, 'lfs'),
          trash: join(data, 'trash'),
        },
        database: { path: join(data, 'app.db') },
      };
      await BackupService.restore(backup, restoredConfig, true);
      const wikiPath = join(data, 'wikis', `${r.storageId}.git`);
      expect(
        (await f.git.run(['--git-dir', wikiPath, 'show', 'main:Home.md'])).stdout.toString(),
      ).toBe('latest');
      expect(
        (await f.git.run(['--git-dir', wikiPath, 'rev-list', '--count', 'main'])).stdout
          .toString()
          .trim(),
      ).toBe('2');
      const key = (
        f.database
          .prepare('SELECT storage_key AS key FROM release_assets WHERE id = ?')
          .get(asset.id) as { key: string }
      ).key;
      expect(await readFile(join(data, 'releases', key), 'utf8')).toBe('saved');
      await f.admin.delete(r, f.user.id);
      f.database
        .prepare('UPDATE repositories SET deleted_at = ? WHERE id = ?')
        .run('2000-01-01T00:00:00.000Z', r.id);
      const releaseRoot = join(f.config.storage.data, 'releases');
      await rm(releaseRoot, { recursive: true });
      await writeFile(releaseRoot, 'invalid directory');
      await expect(f.admin.purgeExpiredTrash()).rejects.toThrow(/Unsafe/);
      expect(
        f.database.prepare('SELECT 1 FROM release_assets WHERE id = ?').get(asset.id),
      ).toBeDefined();
      await rm(releaseRoot);
      await mkdir(releaseRoot);
      await writeFile(join(releaseRoot, key), 'saved');
      expect(await f.admin.purgeExpiredTrash()).toBe(1);
      expect(
        f.database.prepare('SELECT 1 FROM repositories WHERE id = ?').get(r.id),
      ).toBeUndefined();
      await expect(readFile(join(releaseRoot, key))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        readFile(join(f.config.storage.data, 'wikis', `${r.storageId}.git`, 'HEAD')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  });
});
