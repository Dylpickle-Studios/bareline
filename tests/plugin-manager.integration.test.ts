import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { PluginManager } from '../src/plugins/plugin-manager.js';
import { examplePluginArchive } from '../src/plugins/example-download.js';
import { OutboundPolicy } from '../src/security/outbound-policy.js';
import { temporaryConfig } from './helpers.js';

describe('plugin package management', () => {
  it('rejects unallowlisted remote sources before invoking network tools', async () => {
    const config = temporaryConfig();
    config.security.masterKey = Buffer.alloc(32, 3).toString('base64url');
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const admin = await new AuthService(database, config, audit).register({
      username: 'remote-admin',
      displayName: 'Remote Admin',
      password: 'correct horse battery staple',
    });
    const manager = new PluginManager(database, config, audit);
    await expect(
      manager.installGit(admin.id, 'https://untrusted.invalid/plugin.git', 'main', {
        trustedRiskAccepted: false,
      }),
    ).rejects.toThrow('allowlisted');
    await expect(
      manager.installGit(admin.id, 'https://user:secret@example.com/plugin.git', 'main', {
        trustedRiskAccepted: false,
      }),
    ).rejects.toThrow('credentials');
    await expect(
      manager.installNpm(admin.id, 'unapproved-plugin', { trustedRiskAccepted: false }),
    ).rejects.toThrow('allowlisted');
    await expect(
      manager.installNpm(admin.id, 'https://example.com/plugin.tgz', {
        trustedRiskAccepted: false,
      }),
    ).rejects.toThrow('allowlisted');
    config.plugins.allowedGitHosts = ['plugins.example.test'];
    const blockedDns = new PluginManager(
      database,
      config,
      audit,
      new OutboundPolicy(() => Promise.resolve([{ address: '169.254.169.254', family: 4 }])),
    );
    await expect(
      blockedDns.installGit(admin.id, 'https://plugins.example.test/plugin.git', 'main', {
        trustedRiskAccepted: false,
      }),
    ).rejects.toThrow('private or reserved');
    database.close();
  });

  it('normalizes a bounded uploaded archive through the same lifecycle', async () => {
    const config = temporaryConfig();
    config.security.masterKey = Buffer.alloc(32, 4).toString('base64url');
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const admin = await new AuthService(database, config, audit).register({
      username: 'archive-admin',
      displayName: 'Archive Admin',
      password: 'correct horse battery staple',
    });
    const manager = new PluginManager(database, config, audit);
    const plugin = await manager.installArchive(
      admin.id,
      await examplePluginArchive(),
      'repository-word-count.tar.gz',
      { trustedRiskAccepted: true },
    );
    expect(plugin).toMatchObject({
      id: 'example.word-count',
      sourceType: 'archive',
      sourceValue: 'repository-word-count.tar.gz',
      enabled: false,
    });
    database.close();
  });

  it('normalizes local packages, denies permissions by default, encrypts secrets, and reviews updates', async () => {
    const config = temporaryConfig();
    config.security.masterKey = randomBytes(32).toString('base64url');
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const admin = await new AuthService(database, config, audit).register({
      username: 'admin-user',
      displayName: 'Admin',
      password: 'correct horse battery staple',
    });
    const source = await mkdtemp(join(tmpdir(), 'focused-git-plugin-'));
    await writeFile(join(source, 'plugin.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    await writeManifest(source, '1.0.0', ['repositoryContents.read', 'storage.plugin']);
    const manager = new PluginManager(database, config, audit);
    const plugin = await manager.installLocal(admin.id, source, { trustedRiskAccepted: false });
    expect(plugin.permissions.every((permission) => !permission.granted)).toBe(true);
    expect(plugin.packageDigest).toMatch(/^[a-f0-9]{64}$/);
    manager.setPermission(admin.id, plugin.id, 'storage.plugin', true);
    manager.storageSet(plugin.id, 'count', Buffer.from('1'));
    expect(manager.storageGet(plugin.id, 'count')?.toString()).toBe('1');
    manager.setSetting(admin.id, plugin.id, 'apiKey', 'top secret');
    const stored = database
      .prepare(
        'SELECT encrypted_value, value_json FROM plugin_settings WHERE plugin_id = ? AND key = ?',
      )
      .get(plugin.id, 'apiKey') as { encrypted_value: Buffer; value_json: string | null };
    expect(stored.value_json).toBeNull();
    expect(stored.encrypted_value.toString()).not.toContain('top secret');

    await writeManifest(source, '1.1.0', [
      'repositoryContents.read',
      'storage.plugin',
      'network.outbound',
    ]);
    await expect(
      manager.installLocal(admin.id, source, { trustedRiskAccepted: false }),
    ).rejects.toThrow(/ambient capabilities/);
    await writeManifest(source, '1.1.0', ['repositoryContents.read', 'storage.plugin']);
    const updated = await manager.installLocal(admin.id, source, { trustedRiskAccepted: false });
    expect(
      updated.permissions.find((permission) => permission.capability === 'storage.plugin'),
    ).toMatchObject({ requested: true, granted: false });
    database.close();
  });
});

async function writeManifest(
  source: string,
  version: string,
  permissions: string[],
): Promise<void> {
  await writeFile(
    join(source, 'plugin.yml'),
    `id: example.word-count
name: Repository Word Count
version: ${version}
apiVersion: 1
runtime: sandboxed
entrypoint: plugin.wasm
permissions:
${permissions.map((permission) => `  - ${permission}`).join('\n')}
settings:
  apiKey:
    type: secret
    title: API key
`,
    'utf8',
  );
}
