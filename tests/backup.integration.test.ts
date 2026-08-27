import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
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

    await writeFile(join(config.storage.repositories, 'live-only-before-restore'), 'preserve me');
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
    expect(await readdir(config.storage.repositories)).not.toContain('live-only-before-restore');
    const recoveryDirectories = (await readdir(config.storage.data)).filter((entry) =>
      entry.startsWith('pre-restore-'),
    );
    expect(recoveryDirectories).toHaveLength(1);
    const recoveryDirectory = recoveryDirectories[0];
    if (!recoveryDirectory) throw new Error('Restore did not create a recovery directory');
    expect(
      await readFile(
        join(config.storage.data, recoveryDirectory, 'repositories', 'live-only-before-restore'),
        'utf8',
      ),
    ).toBe('preserve me');

    await writeFile(join(destination, 'config.yml'), 'tampered', 'utf8');
    await expect(BackupService.verify(destination)).rejects.toThrow(/checksum/);
    expect(await readFile(join(destination, 'manifest.json'), 'utf8')).toContain('sha256');
  });

  it('cleans a failed staging backup without publishing a partial destination', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const root = await mkdtemp(join(tmpdir(), 'bareline-backup-staging-test-'));
    const destination = join(root, 'backup');
    const missingConfig = join(root, 'missing-config.yml');

    await expect(
      new BackupService(database, config, '1.0.0').create(destination, missingConfig),
    ).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
    expect(await readdir(config.storage.data)).not.toContain('.backup.lock');
    database.close();
  });

  it('authenticates the manifest with the existing security master key', async () => {
    const config = temporaryConfig();
    const key = Buffer.alloc(32, 21).toString('base64url');
    config.security.masterKey = key;
    const database = openDatabase(config.database.path);
    const root = await mkdtemp(join(tmpdir(), 'bareline-backup-auth-test-'));
    const configFile = join(root, 'config.yml');
    const destination = join(root, 'backup');
    await writeFile(configFile, 'server:\n  host: localhost\n', 'utf8');

    const manifest = await new BackupService(database, config, '1.0.0').create(
      destination,
      configFile,
      { quiesce: () => Promise.resolve(() => Promise.resolve()) },
    );
    expect(manifest.consistency.filesystem).toBe('caller-quiesced');
    expect(manifest.integrity?.algorithm).toBe('hmac-sha256');
    await expect(
      BackupService.verify(destination, { masterKey: key, requireAuthenticated: true }),
    ).resolves.toMatchObject({ integrity: { algorithm: 'hmac-sha256' } });

    const tampered = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8')) as {
      applicationVersion: string;
    };
    tampered.applicationVersion = 'tampered';
    await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(tampered)}\n`, 'utf8');
    await expect(
      BackupService.verify(destination, { masterKey: key, requireAuthenticated: true }),
    ).rejects.toThrow(/authentication/);
    database.close();
  });

  it('rejects overlapping restore targets before touching active data', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const root = await mkdtemp(join(tmpdir(), 'bareline-backup-rollback-test-'));
    const configFile = join(root, 'config.yml');
    const destination = join(root, 'backup');
    await writeFile(configFile, 'server:\n  host: localhost\n', 'utf8');
    await mkdir(config.storage.repositories, { recursive: true });
    const sentinel = join(config.storage.repositories, 'must-survive');
    await writeFile(sentinel, 'active');
    await new BackupService(database, config, '1.0.0').create(destination, configFile);
    database.close();

    config.storage.lfs = config.storage.repositories;
    await expect(BackupService.restore(destination, config, true)).rejects.toThrow(/overlap/);
    expect(await readFile(sentinel, 'utf8')).toBe('active');
    expect(
      (await readdir(config.storage.data)).filter(
        (entry) => entry.startsWith('.restore-staging-') || entry.startsWith('pre-restore-'),
      ),
    ).toEqual([]);
  });
});
