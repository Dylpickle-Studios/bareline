import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '../database/database.js';
import { validatePluginManifest } from './manifest.js';

export class SandboxRuntime {
  constructor(
    private readonly database: Database,
    private readonly timeoutMs = 2000,
  ) {}

  async invoke(
    pluginId: string,
    exportName: string,
    arguments_: readonly number[],
  ): Promise<number | bigint> {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(exportName))
      throw new SandboxError('Invalid export name');
    if (arguments_.length > 16 || arguments_.some((value) => !Number.isSafeInteger(value))) {
      throw new SandboxError('Invalid sandbox arguments');
    }
    const row = this.database
      .prepare(
        `
        SELECT package_path, manifest_json FROM plugins
        WHERE id = ? AND enabled = 1 AND runtime = 'sandboxed'
      `,
      )
      .get(pluginId) as { package_path: string; manifest_json: string } | undefined;
    if (!row) throw new SandboxError('Sandboxed plugin is not enabled');
    const manifest = validatePluginManifest(JSON.parse(row.manifest_json) as unknown);
    const packagePath = await realpath(row.package_path);
    const modulePath = await realpath(join(packagePath, manifest.entrypoint));
    if (modulePath !== packagePath && !modulePath.startsWith(`${packagePath}/`)) {
      throw new SandboxError('Plugin entrypoint escapes its package');
    }
    if (!(await lstat(modulePath)).isFile())
      throw new SandboxError('Plugin entrypoint is unavailable');
    await readSandboxModule(modulePath);

    const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'sandbox-worker-process.mjs');
    const child = fork(workerPath, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [
        '--permission',
        `--allow-fs-read=${workerPath}`,
        `--allow-fs-read=${modulePath}`,
        '--no-addons',
        '--max-old-space-size=64',
        '--disable-proto=throw',
      ],
      env: { NODE_ENV: 'production' },
    });
    const id = randomUUID();
    return await new Promise<number | bigint>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new SandboxError('Sandbox invocation exceeded its time limit'));
      }, this.timeoutMs);
      const finish = (error?: Error, result?: number | bigint): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        if (error) reject(error);
        else if (result !== undefined) resolve(result);
        else reject(new SandboxError('Sandbox returned no result'));
      };
      child.on('error', (error) => {
        finish(error);
      });
      child.on('exit', (code) => {
        if (code !== null && code !== 0)
          finish(new SandboxError('Sandbox process exited unexpectedly'));
      });
      child.on('message', (message: unknown) => {
        if (typeof message !== 'object' || message === null) return;
        const response = message as {
          id?: unknown;
          ok?: unknown;
          result?: unknown;
          resultType?: unknown;
          error?: unknown;
        };
        if (response.id !== id) return;
        if (response.ok !== true || typeof response.result !== 'string') {
          finish(
            new SandboxError(
              typeof response.error === 'string' ? response.error : 'Sandbox failed',
            ),
          );
          return;
        }
        finish(
          undefined,
          response.resultType === 'bigint' ? BigInt(response.result) : Number(response.result),
        );
      });
      child.send({ id, modulePath, exportName, arguments: [...arguments_] });
    });
  }

  async invokeJson<T = unknown>(
    pluginId: string,
    exportName: string,
    request: unknown,
  ): Promise<T> {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(exportName))
      throw new SandboxError('Invalid export name');
    const requestJson = JSON.stringify(request);
    if (Buffer.byteLength(requestJson) > 1024 * 1024)
      throw new SandboxError('Sandbox request exceeds 1 MiB');
    const row = this.database
      .prepare(
        `SELECT package_path, manifest_json FROM plugins
         WHERE id = ? AND enabled = 1 AND runtime = 'sandboxed'`,
      )
      .get(pluginId) as { package_path: string; manifest_json: string } | undefined;
    if (!row) throw new SandboxError('Sandboxed plugin is not enabled');
    const manifest = validatePluginManifest(JSON.parse(row.manifest_json) as unknown);
    const packagePath = await realpath(row.package_path);
    const modulePath = await realpath(join(packagePath, manifest.entrypoint));
    if (modulePath !== packagePath && !modulePath.startsWith(`${packagePath}/`))
      throw new SandboxError('Plugin entrypoint escapes its package');
    if (!(await lstat(modulePath)).isFile())
      throw new SandboxError('Plugin entrypoint is unavailable');
    await readSandboxModule(modulePath);
    const capabilities = (
      this.database
        .prepare(
          'SELECT capability FROM plugin_permissions WHERE plugin_id = ? AND requested = 1 AND granted = 1 ORDER BY capability',
        )
        .all(pluginId) as { capability: string }[]
    ).map((row) => row.capability);
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'sandbox-worker-process.mjs');
    const child = fork(workerPath, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [
        '--permission',
        `--allow-fs-read=${workerPath}`,
        `--allow-fs-read=${modulePath}`,
        '--no-addons',
        '--max-old-space-size=64',
        '--disable-proto=throw',
      ],
      env: { NODE_ENV: 'production' },
    });
    const storage = capabilities.includes('storage.plugin') ? this.storageSnapshot(pluginId) : null;
    const id = randomUUID();
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new SandboxError('Sandbox invocation exceeded its time limit'));
      }, this.timeoutMs);
      let settled = false;
      const finish = (error?: Error, result?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        if (error) reject(error);
        else resolve(result as T);
      };
      child.on('error', (error) => {
        finish(error);
      });
      child.on('exit', (code) => {
        if (code !== null && code !== 0)
          finish(new SandboxError('Sandbox process exited unexpectedly'));
      });
      child.on('message', (message: unknown) => {
        if (typeof message !== 'object' || message === null) return;
        const response = message as {
          id?: unknown;
          ok?: unknown;
          result?: unknown;
          error?: unknown;
        };
        if (response.id !== id) return;
        if (response.ok !== true) {
          finish(
            new SandboxError(
              typeof response.error === 'string' ? response.error : 'Sandbox failed',
            ),
          );
          return;
        }
        try {
          finish(undefined, this.applyHostResponse(pluginId, capabilities, response.result) as T);
        } catch (error) {
          finish(error instanceof Error ? error : new SandboxError('Invalid sandbox response'));
        }
      });
      child.send({
        id,
        mode: 'json',
        modulePath,
        exportName,
        request: {
          apiVersion: 1,
          capabilities,
          host: storage === null ? {} : { storage },
          input: JSON.parse(requestJson) as unknown,
        },
      });
    });
  }

  private storageSnapshot(pluginId: string): Record<string, string> {
    const rows = this.database
      .prepare('SELECT key, value FROM plugin_storage WHERE plugin_id = ? ORDER BY key LIMIT 1000')
      .all(pluginId) as { key: string; value: Buffer }[];
    let bytes = 0;
    const result: Record<string, string> = {};
    for (const row of rows) {
      bytes += row.value.length;
      if (bytes > 1024 * 1024) throw new SandboxError('Plugin storage snapshot exceeds 1 MiB');
      result[row.key] = row.value.toString('base64');
    }
    return result;
  }

  private applyHostResponse(
    pluginId: string,
    capabilities: readonly string[],
    value: unknown,
  ): unknown {
    if (typeof value !== 'object' || value === null || !('gitHost' in value)) return value;
    const envelope = value as { gitHost?: unknown; result?: unknown };
    if (typeof envelope.gitHost !== 'object' || envelope.gitHost === null)
      throw new SandboxError('Sandbox host response is invalid');
    const host = envelope.gitHost as { apiVersion?: unknown; effects?: unknown };
    if (host.apiVersion !== 1 || !Array.isArray(host.effects) || host.effects.length > 100)
      throw new SandboxError('Sandbox host effects are invalid');
    if (!capabilities.includes('storage.plugin') && host.effects.length > 0)
      throw new SandboxError('Sandbox requested a denied host capability');
    this.database.transaction(() => {
      for (const rawEffect of host.effects as unknown[]) {
        if (typeof rawEffect !== 'object' || rawEffect === null)
          throw new SandboxError('Sandbox storage effect is invalid');
        const effect = rawEffect as { operation?: unknown; key?: unknown; value?: unknown };
        if (typeof effect.key !== 'string' || !/^[A-Za-z0-9_.-]{1,200}$/.test(effect.key))
          throw new SandboxError('Sandbox storage key is invalid');
        if (effect.operation === 'delete') {
          this.database
            .prepare('DELETE FROM plugin_storage WHERE plugin_id = ? AND key = ?')
            .run(pluginId, effect.key);
        } else if (effect.operation === 'set' && typeof effect.value === 'string') {
          const decoded = Buffer.from(effect.value, 'base64');
          if (decoded.length > 1024 * 1024 || decoded.toString('base64') !== effect.value)
            throw new SandboxError('Sandbox storage value is invalid');
          this.database
            .prepare(
              `INSERT INTO plugin_storage(plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?)
               ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value,
                 updated_at = excluded.updated_at`,
            )
            .run(pluginId, effect.key, decoded, new Date().toISOString());
        } else throw new SandboxError('Sandbox storage operation is invalid');
      }
    })();
    return envelope.result;
  }
}

async function readSandboxModule(path: string): Promise<Buffer> {
  const bytes = await readFile(path);
  if (bytes.length > 64 * 1024 * 1024) throw new SandboxError('WebAssembly module exceeds 64 MiB');
  return bytes;
}

export class SandboxError extends Error {
  readonly statusCode = 500;
}
