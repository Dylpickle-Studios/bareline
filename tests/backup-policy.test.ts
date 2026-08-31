import { existsSync } from 'node:fs';
import { mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BackupPolicyService, type BackupPolicy } from '../src/backup/backup-policy-service.js';
import { openDatabase } from '../src/database/database.js';
import { temporaryConfig } from './helpers.js';

describe('backup policy', () => {
  it('dry-runs safely, verifies created backups, and bounds retention', async () => {
    const config = temporaryConfig();
    config.security.masterKey = Buffer.alloc(32, 7).toString('base64url');
    const root = await mkdtemp(join(tmpdir(), 'bareline-backup-policy-'));
    const output = join(root, 'backups');
    const configFile = join(root, 'config.yml');
    await writeFile(configFile, 'server:\n  host: localhost\n', 'utf8');
    const database = openDatabase(config.database.path);
    const policy: BackupPolicy = { output, intervalHours: 1, retain: 1 };
    const firstTime = new Date('2026-08-31T10:00:00.000Z');
    const service = new BackupPolicyService(database, config, '1.1.0', () => firstTime);

    await expect(service.status(policy)).resolves.toMatchObject({ due: true, retained: 0 });
    const preview = await service.run(policy, configFile, { dryRun: true });
    expect(preview.created).toMatch(/bareline-20260831T100000000Z-/);
    expect(existsSync(output)).toBe(false);

    const first = await service.run(policy, configFile);
    expect(first.created).toMatch(/bareline-20260831T100000000Z-/);
    expect(first.removed).toEqual([]);
    expect((await readdir(output)).filter((entry) => entry.startsWith('bareline-'))).toHaveLength(
      1,
    );
    if (!first.latestCreatedAt) throw new Error('Created backup did not report its creation time');
    const notDueTime = new Date(new Date(first.latestCreatedAt).getTime() + 30 * 60 * 1000);
    const notDue = new BackupPolicyService(database, config, '1.1.0', () => notDueTime);
    await expect(notDue.run(policy, configFile)).resolves.not.toHaveProperty('created');

    const secondTime = new Date(new Date(first.latestCreatedAt).getTime() + 61 * 60 * 1000);
    const later = new BackupPolicyService(database, config, '1.1.0', () => secondTime);
    const second = await later.run(policy, configFile);
    expect(second.created).toMatch(/bareline-/);
    expect(second.removed).toHaveLength(1);
    expect((await readdir(output)).filter((entry) => entry.startsWith('bareline-'))).toHaveLength(
      1,
    );
    database.close();
  });

  it('rejects policy output inside live application storage', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const service = new BackupPolicyService(database, config, '1.1.0');
    await expect(
      service.status({
        output: join(config.storage.data, 'backups'),
        intervalHours: 24,
        retain: 7,
      }),
    ).rejects.toThrow(/outside storage.data/);
    database.close();
  });

  it('refuses a policy output that traverses a symbolic link', async () => {
    const config = temporaryConfig();
    const root = await mkdtemp(join(tmpdir(), 'bareline-backup-policy-link-'));
    const linked = join(root, 'linked');
    await symlink(root, linked);
    const database = openDatabase(config.database.path);
    const service = new BackupPolicyService(database, config, '1.1.0');
    await expect(
      service.status({ output: join(linked, 'backups'), intervalHours: 24, retain: 7 }),
    ).rejects.toThrow(/symbolic links/);
    database.close();
  });
});
