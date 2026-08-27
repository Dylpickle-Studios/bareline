import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import type { AuditService } from '../audit/audit-service.js';
import type { AppConfig } from '../config/config.js';
import type { Database } from '../database/database.js';
import { SecretBox } from '../security/secret-box.js';
import { OutboundPolicy, OutboundPolicyError } from '../security/outbound-policy.js';
import { type PluginManifest, pluginCapabilities, validatePluginManifest } from './manifest.js';
import { extractPluginArchive } from './package-archive.js';
import { validateRef } from '../security/validation.js';

const runFile = promisify(execFile);

export interface PluginView {
  id: string;
  name: string;
  version: string;
  runtime: 'trusted' | 'sandboxed';
  sourceType: string;
  sourceValue: string;
  enabled: boolean;
  error: string | null;
  packageDigest: string | null;
  permissions: { capability: string; requested: boolean; granted: boolean }[];
  manifest: PluginManifest;
}

export class PluginManager {
  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly outboundPolicy = new OutboundPolicy(),
  ) {}

  async installLocal(
    actorUserId: number,
    sourceInput: string,
    options: { trustedRiskAccepted: boolean; sourceType?: string; sourceValue?: string },
  ): Promise<PluginView> {
    this.requireAdministrator(actorUserId);
    const source = await realpath(resolve(sourceInput));
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
      throw new PluginInstallError('Plugin source must be a real directory');
    }
    const manifestSource = await readFile(join(source, 'plugin.yml'), 'utf8');
    if (manifestSource.length > 1024 * 1024)
      throw new PluginInstallError('Plugin manifest is too large');
    const manifest = validatePluginManifest(YAML.parse(manifestSource) as unknown);
    if (manifest.runtime === 'trusted' && !options.trustedRiskAccepted) {
      throw new PluginInstallError(
        'Trusted plugins require explicit host-compromise risk acceptance',
      );
    }
    const entrypoint = await realpath(join(source, manifest.entrypoint));
    if (entrypoint !== source && !entrypoint.startsWith(`${source}/`)) {
      throw new PluginInstallError('Plugin entrypoint escapes its package');
    }
    if (!(await lstat(entrypoint)).isFile())
      throw new PluginInstallError('Plugin entrypoint is not a file');

    const packageRoot = join(this.config.storage.data, 'plugins');
    const destination = join(packageRoot, manifest.id, manifest.version);
    await mkdir(dirname(destination), { recursive: true, mode: 0o750 });
    if (await pathExists(destination))
      throw new PluginInstallError('This plugin version is already installed');
    await copyPackage(source, destination);
    const digest = await packageDigest(destination);
    const now = new Date().toISOString();
    const existing = this.database
      .prepare('SELECT manifest_json FROM plugins WHERE id = ?')
      .get(manifest.id) as { manifest_json: string } | undefined;
    const previousManifest = existing
      ? validatePluginManifest(JSON.parse(existing.manifest_json) as unknown)
      : null;
    this.database.transaction(() => {
      this.database
        .prepare(
          `
          INSERT INTO plugins
            (id, name, version, api_version, runtime, source_type, source_value, package_path,
            manifest_json, package_digest, enabled, installed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name, version = excluded.version, api_version = excluded.api_version,
            runtime = excluded.runtime, source_type = excluded.source_type,
            source_value = excluded.source_value, package_path = excluded.package_path,
            manifest_json = excluded.manifest_json, package_digest = excluded.package_digest,
            enabled = 0, error = NULL,
            updated_at = excluded.updated_at
        `,
        )
        .run(
          manifest.id,
          manifest.name,
          manifest.version,
          manifest.apiVersion,
          manifest.runtime,
          options.sourceType ?? 'local',
          options.sourceValue ?? source,
          destination,
          JSON.stringify(manifest),
          digest,
          now,
          now,
        );
      const requested = new Set(manifest.permissions);
      for (const capability of pluginCapabilities) {
        if (requested.has(capability)) {
          this.database
            .prepare(
              `
              INSERT INTO plugin_permissions(plugin_id, capability, requested, granted)
              VALUES (?, ?, 1, 0)
              ON CONFLICT(plugin_id, capability) DO UPDATE SET requested = 1, granted = 0
            `,
            )
            .run(manifest.id, capability);
        } else {
          this.database
            .prepare('DELETE FROM plugin_permissions WHERE plugin_id = ? AND capability = ?')
            .run(manifest.id, capability);
        }
      }
      this.audit.record({
        actorUserId,
        action: existing ? 'plugin.updated' : 'plugin.installed',
        targetType: 'plugin',
        targetId: manifest.id,
        metadata: {
          version: manifest.version,
          runtime: manifest.runtime,
          newPermissions: previousManifest
            ? manifest.permissions
                .filter((permission) => !previousManifest.permissions.includes(permission))
                .join(',')
            : manifest.permissions.join(','),
        },
      });
    })();
    return this.get(manifest.id);
  }

  async installArchive(
    actorUserId: number,
    archive: Buffer,
    sourceLabel: string,
    options: { trustedRiskAccepted: boolean; sourceType?: string },
  ): Promise<PluginView> {
    this.requireAdministrator(actorUserId);
    const stagingRoot = join(this.config.storage.data, 'plugin-staging');
    await mkdir(stagingRoot, { recursive: true, mode: 0o750 });
    const staging = await mkdtemp(join(stagingRoot, 'archive-'));
    try {
      await extractPluginArchive(archive, staging);
      return await this.installLocal(actorUserId, staging, {
        trustedRiskAccepted: options.trustedRiskAccepted,
        sourceType: options.sourceType ?? 'archive',
        sourceValue: sourceLabel.slice(0, 500),
      });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async installGit(
    actorUserId: number,
    remoteInput: string,
    refInput: string,
    options: { trustedRiskAccepted: boolean },
  ): Promise<PluginView> {
    this.requireAdministrator(actorUserId);
    let remote: URL;
    try {
      remote = await this.outboundPolicy.assertSafeUrl(remoteInput, {
        allowedHosts: this.config.plugins.allowedGitHosts,
        protocols: ['https:'],
        ports: [443],
      });
    } catch (error) {
      if (error instanceof OutboundPolicyError) throw new PluginInstallError(error.message);
      throw new PluginInstallError('Git plugin source must be a valid HTTPS URL');
    }
    const ref = validateRef(refInput || 'main');
    const stagingRoot = join(this.config.storage.data, 'plugin-staging');
    await mkdir(stagingRoot, { recursive: true, mode: 0o750 });
    const staging = await mkdtemp(join(stagingRoot, 'git-'));
    const checkout = join(staging, 'checkout');
    try {
      await runFile(
        this.config.git.executable,
        [
          '-c',
          'protocol.file.allow=never',
          '-c',
          'protocol.ext.allow=never',
          '-c',
          'http.followRedirects=false',
          '-c',
          'core.hooksPath=/dev/null',
          'clone',
          '--depth=1',
          '--no-recurse-submodules',
          '--branch',
          ref,
          '--',
          remote.href,
          checkout,
        ],
        {
          timeout: this.config.plugins.installTimeoutMs,
          maxBuffer: 1024 * 1024,
          env: safeInstallEnvironment(),
        },
      );
      const commit = (
        await runFile(
          this.config.git.executable,
          ['-C', checkout, 'rev-parse', '--verify', 'HEAD'],
          {
            timeout: this.config.plugins.installTimeoutMs,
            maxBuffer: 4096,
            env: safeInstallEnvironment(),
          },
        )
      ).stdout.trim();
      if (!/^[a-f0-9]{40,64}$/i.test(commit))
        throw new PluginInstallError('Git plugin checkout did not resolve to an immutable commit');
      await rm(join(checkout, '.git'), { recursive: true, force: true });
      return await this.installLocal(actorUserId, checkout, {
        trustedRiskAccepted: options.trustedRiskAccepted,
        sourceType: 'git',
        sourceValue: `${remote.href}#${commit}`,
      });
    } catch (error) {
      if (error instanceof PluginInstallError) throw error;
      throw new PluginInstallError('Unable to fetch or validate the Git plugin package');
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async installNpm(
    actorUserId: number,
    packageInput: string,
    options: { trustedRiskAccepted: boolean },
  ): Promise<PluginView> {
    this.requireAdministrator(actorUserId);
    const match =
      /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?))?$/.exec(
        packageInput,
      );
    const packageName = match?.[1];
    const version = match?.[2];
    if (!packageName || !version || !this.config.plugins.allowedNpmPackages.includes(packageName))
      throw new PluginInstallError('npm plugin package is not allowlisted');
    const specification = `${packageName}@${version}`;
    const stagingRoot = join(this.config.storage.data, 'plugin-staging');
    await mkdir(stagingRoot, { recursive: true, mode: 0o750 });
    const staging = await mkdtemp(join(stagingRoot, 'npm-'));
    try {
      const result = await runFile(
        this.config.plugins.npmExecutable,
        ['pack', '--ignore-scripts', '--json', '--pack-destination', staging, specification],
        {
          timeout: this.config.plugins.installTimeoutMs,
          maxBuffer: 1024 * 1024,
          env: { ...safeInstallEnvironment(), npm_config_cache: join(staging, 'cache') },
        },
      );
      const report = JSON.parse(result.stdout) as unknown;
      const filename =
        Array.isArray(report) && typeof report[0] === 'object' && report[0] !== null
          ? (report[0] as { filename?: unknown }).filename
          : null;
      if (typeof filename !== 'string' || !/^[A-Za-z0-9._-]+\.tgz$/.test(filename))
        throw new PluginInstallError('npm returned an invalid package artifact');
      return await this.installArchive(
        actorUserId,
        await readFile(join(staging, filename)),
        specification,
        { trustedRiskAccepted: options.trustedRiskAccepted, sourceType: 'npm' },
      );
    } catch (error) {
      if (error instanceof PluginInstallError) throw error;
      throw new PluginInstallError('Unable to fetch or validate the npm plugin package');
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  setPermission(actorUserId: number, pluginId: string, capability: string, granted: boolean): void {
    this.requireAdministrator(actorUserId);
    if (!(pluginCapabilities as readonly string[]).includes(capability)) {
      throw new PluginInstallError('Unknown plugin capability');
    }
    const result = this.database
      .prepare(
        `
        UPDATE plugin_permissions SET granted = ?
        WHERE plugin_id = ? AND capability = ? AND requested = 1
      `,
      )
      .run(granted ? 1 : 0, pluginId, capability);
    if (result.changes !== 1)
      throw new PluginInstallError('Plugin did not request this capability');
    this.database.prepare('UPDATE plugins SET enabled = 0 WHERE id = ?').run(pluginId);
    this.audit.record({
      actorUserId,
      action: 'plugin.permissionChanged',
      targetType: 'plugin',
      targetId: pluginId,
      metadata: { capability, granted },
    });
  }

  setEnabled(
    actorUserId: number,
    pluginId: string,
    enabled: boolean,
    trustedRiskAccepted: boolean,
  ): void {
    this.requireAdministrator(actorUserId);
    const plugin = this.get(pluginId);
    if (enabled && plugin.runtime === 'trusted' && !trustedRiskAccepted) {
      throw new PluginInstallError('Enabling trusted code requires explicit risk acceptance');
    }
    this.database
      .prepare('UPDATE plugins SET enabled = ?, error = NULL WHERE id = ?')
      .run(enabled ? 1 : 0, pluginId);
    this.audit.record({
      actorUserId,
      action: enabled ? 'plugin.enabled' : 'plugin.disabled',
      targetType: 'plugin',
      targetId: pluginId,
    });
  }

  setSetting(actorUserId: number, pluginId: string, key: string, value: unknown): void {
    this.requireAdministrator(actorUserId);
    const plugin = this.get(pluginId);
    const schema = plugin.manifest.settings[key];
    if (!schema) throw new PluginInstallError('Unknown plugin setting');
    validateSetting(schema, value);
    const now = new Date().toISOString();
    if (schema.type === 'secret') {
      if (typeof value !== 'string')
        throw new PluginInstallError('Secret setting must be a string');
      const encrypted = new SecretBox(this.config.security.masterKey).encrypt(
        value,
        `plugin:${pluginId}:${key}`,
      );
      this.database
        .prepare(
          `
          INSERT INTO plugin_settings(plugin_id, key, value_json, encrypted_value, updated_at)
          VALUES (?, ?, NULL, ?, ?)
          ON CONFLICT(plugin_id, key) DO UPDATE SET
            value_json = NULL, encrypted_value = excluded.encrypted_value, updated_at = excluded.updated_at
        `,
        )
        .run(pluginId, key, encrypted, now);
    } else {
      this.database
        .prepare(
          `
          INSERT INTO plugin_settings(plugin_id, key, value_json, encrypted_value, updated_at)
          VALUES (?, ?, ?, NULL, ?)
          ON CONFLICT(plugin_id, key) DO UPDATE SET
            value_json = excluded.value_json, encrypted_value = NULL, updated_at = excluded.updated_at
        `,
        )
        .run(pluginId, key, JSON.stringify(value), now);
    }
    this.audit.record({
      actorUserId,
      action: 'plugin.settingChanged',
      targetType: 'plugin',
      targetId: pluginId,
      metadata: { key, valueKind: schema.type === 'secret' ? 'encrypted' : 'plain' },
    });
  }

  storageGet(pluginId: string, key: string): Buffer | null {
    validateStorageKey(key);
    if (!this.hasCapability(pluginId, 'storage.plugin')) throw new PluginPermissionError();
    const row = this.database
      .prepare('SELECT value FROM plugin_storage WHERE plugin_id = ? AND key = ?')
      .get(pluginId, key) as { value: Buffer } | undefined;
    return row?.value ?? null;
  }

  storageSet(pluginId: string, key: string, value: Buffer): void {
    validateStorageKey(key);
    if (value.length > 1024 * 1024)
      throw new PluginInstallError('Plugin storage value exceeds 1 MiB');
    if (!this.hasCapability(pluginId, 'storage.plugin')) throw new PluginPermissionError();
    this.database
      .prepare(
        `
        INSERT INTO plugin_storage(plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `,
      )
      .run(pluginId, key, value, new Date().toISOString());
  }

  storageDelete(pluginId: string, key: string): void {
    validateStorageKey(key);
    if (!this.hasCapability(pluginId, 'storage.plugin')) throw new PluginPermissionError();
    this.database
      .prepare('DELETE FROM plugin_storage WHERE plugin_id = ? AND key = ?')
      .run(pluginId, key);
  }

  hasCapability(pluginId: string, capability: string): boolean {
    return Boolean(
      this.database
        .prepare(
          'SELECT 1 FROM plugin_permissions WHERE plugin_id = ? AND capability = ? AND requested = 1 AND granted = 1',
        )
        .get(pluginId, capability),
    );
  }

  async entrypoint(pluginId: string): Promise<string> {
    const plugin = this.get(pluginId);
    if (!plugin.enabled) throw new PluginInstallError('Plugin is not enabled');
    const row = this.database
      .prepare('SELECT package_path FROM plugins WHERE id = ?')
      .get(pluginId) as { package_path: string };
    const packagePath = await realpath(row.package_path);
    const entrypoint = await realpath(join(packagePath, plugin.manifest.entrypoint));
    if (entrypoint !== packagePath && !entrypoint.startsWith(`${packagePath}/`))
      throw new PluginInstallError('Plugin entrypoint escapes its package');
    return entrypoint;
  }

  settingsView(pluginId: string): Record<string, { configured: boolean; value: unknown }> {
    const plugin = this.get(pluginId);
    const rows = this.database
      .prepare('SELECT key, value_json, encrypted_value FROM plugin_settings WHERE plugin_id = ?')
      .all(pluginId) as {
      key: string;
      value_json: string | null;
      encrypted_value: Buffer | null;
    }[];
    const stored = new Map(rows.map((row) => [row.key, row]));
    return Object.fromEntries(
      Object.entries(plugin.manifest.settings).map(([key, schema]) => {
        const row = stored.get(key);
        return [
          key,
          {
            configured: Boolean(row),
            value:
              schema.type === 'secret'
                ? null
                : row?.value_json
                  ? (JSON.parse(row.value_json) as unknown)
                  : 'default' in schema
                    ? schema.default
                    : null,
          },
        ];
      }),
    );
  }

  list(): PluginView[] {
    const rows = this.database.prepare('SELECT id FROM plugins ORDER BY name, id').all() as {
      id: string;
    }[];
    return rows.map((row) => this.get(row.id));
  }

  async remove(actorUserId: number, pluginId: string, keepData: boolean): Promise<void> {
    this.requireAdministrator(actorUserId);
    const row = this.database
      .prepare('SELECT package_path FROM plugins WHERE id = ?')
      .get(pluginId) as { package_path: string } | undefined;
    if (!row) throw new PluginInstallError('Plugin not found');
    const packageRoot = await realpath(join(this.config.storage.data, 'plugins'));
    const packagePath = await realpath(row.package_path);
    if (!packagePath.startsWith(`${packageRoot}/`))
      throw new PluginInstallError('Plugin package path is unsafe');
    const trashRoot = join(this.config.storage.data, 'plugin-trash');
    await mkdir(trashRoot, { recursive: true, mode: 0o750 });
    const destination = join(trashRoot, `${pluginId}.${String(Date.now())}`);
    await rename(packagePath, destination);
    try {
      this.database.transaction(() => {
        if (keepData) {
          const archivedAt = new Date().toISOString();
          this.database
            .prepare(
              `
              INSERT OR REPLACE INTO orphaned_plugin_data(plugin_id, kind, key, value, archived_at)
              SELECT plugin_id, 'storage', key, value, ? FROM plugin_storage WHERE plugin_id = ?
            `,
            )
            .run(archivedAt, pluginId);
          const settings = this.database
            .prepare(
              'SELECT key, value_json, encrypted_value FROM plugin_settings WHERE plugin_id = ?',
            )
            .all(pluginId) as {
            key: string;
            value_json: string | null;
            encrypted_value: Buffer | null;
          }[];
          const insert = this.database.prepare(`
            INSERT OR REPLACE INTO orphaned_plugin_data(plugin_id, kind, key, value, archived_at)
            VALUES (?, 'setting', ?, ?, ?)
          `);
          for (const setting of settings) {
            insert.run(
              pluginId,
              setting.key,
              setting.encrypted_value ?? Buffer.from(setting.value_json ?? 'null'),
              archivedAt,
            );
          }
        }
        this.database.prepare('DELETE FROM plugins WHERE id = ?').run(pluginId);
        this.audit.record({
          actorUserId,
          action: 'plugin.removed',
          targetType: 'plugin',
          targetId: pluginId,
          metadata: { dataRetention: keepData ? 'kept' : 'removed' },
        });
      })();
    } catch (error) {
      await rename(destination, packagePath);
      throw error;
    }
  }

  get(pluginId: string): PluginView {
    const row = this.database
      .prepare(
        `
        SELECT id, name, version, runtime, source_type, source_value, enabled, error,
               package_digest AS packageDigest, manifest_json
        FROM plugins WHERE id = ?
      `,
      )
      .get(pluginId) as
      | {
          id: string;
          name: string;
          version: string;
          runtime: 'trusted' | 'sandboxed';
          source_type: string;
          source_value: string;
          enabled: number;
          error: string | null;
          packageDigest: string | null;
          manifest_json: string;
        }
      | undefined;
    if (!row) throw new PluginInstallError('Plugin not found');
    const permissions = this.database
      .prepare(
        'SELECT capability, requested, granted FROM plugin_permissions WHERE plugin_id = ? ORDER BY capability',
      )
      .all(pluginId) as { capability: string; requested: number; granted: number }[];
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      runtime: row.runtime,
      sourceType: row.source_type,
      sourceValue: row.source_value,
      enabled: row.enabled === 1,
      error: row.error,
      packageDigest: row.packageDigest,
      manifest: validatePluginManifest(JSON.parse(row.manifest_json) as unknown),
      permissions: permissions.map((permission) => ({
        capability: permission.capability,
        requested: permission.requested === 1,
        granted: permission.granted === 1,
      })),
    };
  }

  private requireAdministrator(userId: number): void {
    const row = this.database
      .prepare("SELECT is_admin FROM users WHERE id = ? AND status = 'active'")
      .get(userId) as { is_admin: number } | undefined;
    if (row?.is_admin !== 1) throw new PluginPermissionError();
  }
}

async function copyPackage(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: false, mode: 0o750 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink())
      throw new PluginInstallError(`Plugin package contains a symlink: ${entry.name}`);
    if (entry.isDirectory()) await copyPackage(sourcePath, destinationPath);
    else if (entry.isFile()) {
      const info = await lstat(sourcePath);
      if (info.size > 64 * 1024 * 1024)
        throw new PluginInstallError(`Plugin file is too large: ${entry.name}`);
      await copyFile(sourcePath, destinationPath);
    } else
      throw new PluginInstallError(`Plugin package contains an unsupported entry: ${entry.name}`);
  }
}

function validateSetting(schema: PluginManifest['settings'][string], value: unknown): void {
  const valid =
    (['string', 'secret', 'url'].includes(schema.type) && typeof value === 'string') ||
    (schema.type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
    (schema.type === 'boolean' && typeof value === 'boolean') ||
    (schema.type === 'select' && typeof value === 'string' && schema.options.includes(value)) ||
    (schema.type === 'multi-select' &&
      Array.isArray(value) &&
      value.every((item) => typeof item === 'string' && schema.options.includes(item)));
  if (!valid) throw new PluginInstallError('Plugin setting value does not match its schema');
  if (schema.type === 'url' && typeof value === 'string') {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol))
      throw new PluginInstallError('Plugin URL must use HTTP or HTTPS');
  }
}

function validateStorageKey(key: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(key))
    throw new PluginInstallError('Invalid plugin storage key');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function safeInstallEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: '/nonexistent',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PROTOCOL_FROM_USER: '0',
    npm_config_ignore_scripts: 'true',
    npm_config_userconfig: '/dev/null',
    npm_config_audit: 'false',
  };
}

export async function packageDigest(directory: string): Promise<string> {
  const hash = createHash('sha256');
  async function walk(path: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.isSymbolicLink())
        throw new PluginInstallError('Plugin digest refuses symbolic links');
      const fullPath = join(path, entry.name);
      const logical = relative(directory, fullPath).split('\\').join('/');
      hash.update(logical).update('\0');
      if (entry.isDirectory()) await walk(fullPath);
      else hash.update(await readFile(fullPath)).update('\0');
    }
  }
  await walk(directory);
  return hash.digest('hex');
}

export class PluginInstallError extends Error {
  readonly statusCode = 400;
}
export class PluginPermissionError extends Error {
  readonly statusCode = 403;
}
