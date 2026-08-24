import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { BackupService } from '../src/backup/backup-service.js';
import { openDatabase } from '../src/database/database.js';
import { GitRunner } from '../src/git/git-runner.js';
import { RepositoryService } from '../src/repositories/repository-service.js';
import { temporaryConfig } from './helpers.js';

describe('backup and restore', () => {
  it('backs up online SQLite and Git data, verifies checksums, and restores recoverably', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const user = await new AuthService(database, config, audit).register({
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse battery staple',
    });
    await new RepositoryService(
      database,
      new GitRunner('git', 10_000, 16 * 1024 * 1024),
      config,
      audit,
    ).createForUser({
      actorUserId: user.id,
      ownerUserId: user.id,
      slug: 'example',
      visibility: 'private',
      initializeReadme: true,
    });
    const root = await mkdtemp(join(tmpdir(), 'focused-git-backup-test-'));
    const configFile = join(root, 'config.yml');
    const destination = join(root, 'backup');
    await mkdir(join(config.storage.data, 'plugins', 'example.plugin', '1.0.0'), {
      recursive: true,
    });
    await writeFile(
      join(config.storage.data, 'plugins', 'example.plugin', '1.0.0', 'plugin.yml'),
      'id: example.plugin\n',
    );
    await mkdir(config.storage.trash, { recursive: true });
    await writeFile(join(config.storage.trash, 'deleted.git'), 'recoverable');
    await writeFile(configFile, 'server:\n  host: localhost\n', 'utf8');
    const manifest = await new BackupService(database, config, '0.1.0').create(
      destination,
      configFile,
    );
    expect(Object.keys(manifest.files)).toContain('app.db');
    expect(Object.keys(manifest.files)).toContain('plugins/example.plugin/1.0.0/plugin.yml');
    expect(Object.keys(manifest.files)).toContain('repository-trash/deleted.git');
    await expect(BackupService.verify(destination)).resolves.toMatchObject({ formatVersion: 1 });
    database.close();

    await expect(BackupService.restore(destination, config, false)).rejects.toThrow(/confirm/);
    await BackupService.restore(destination, config, true);
    const restored = openDatabase(config.database.path);
    expect(restored.prepare('SELECT username FROM users').get()).toEqual({ username: 'alice' });
    restored.close();
    expect(
      await readFile(
        join(config.storage.data, 'plugins', 'example.plugin', '1.0.0', 'plugin.yml'),
        'utf8',
      ),
    ).toContain('example.plugin');
    expect(await readFile(join(config.storage.trash, 'deleted.git'), 'utf8')).toBe('recoverable');

    await writeFile(join(destination, 'config.yml'), 'tampered', 'utf8');
    await expect(BackupService.verify(destination)).rejects.toThrow(/checksum/);
    expect(await readFile(join(destination, 'manifest.json'), 'utf8')).toContain('sha256');
  });
});
