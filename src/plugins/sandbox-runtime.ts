import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '../database/database.js';
import { ConcurrencyLimiter, terminateChildProcess } from '../security/process-limits.js';
import { sandboxSupportedCapabilities, validatePluginManifest } from './manifest.js';
import { packageDigest } from './plugin-manager.js';

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_WASM_MEMORY_BYTES = 16 * 1024 * 1024;
const DEFAULT_WORKER_HEAP_MB = 64;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_PENDING = 16;

export interface SandboxRuntimeOptions {
  readonly maxConcurrent?: number;
  readonly maxPending?: number;
  readonly wasmMemoryBytes?: number;
  readonly workerHeapMegabytes?: number;
}

interface PreparedSandbox {
  readonly modulePath: string;
  readonly workerPath: string;
  readonly capabilities: readonly string[];
}

interface WorkerResponse {
  readonly id?: unknown;
  readonly ok?: unknown;
  readonly result?: unknown;
  readonly resultType?: unknown;
  readonly error?: unknown;
}

export class SandboxRuntime {
  private readonly timeoutMs: number;
  private readonly wasmMemoryBytes: number;
  private readonly workerHeapMegabytes: number;
  private readonly limiter: ConcurrencyLimiter;

  constructor(
    private readonly database: Database,
    timeoutMs = 2000,
    options: SandboxRuntimeOptions = {},
  ) {
    this.timeoutMs = requirePositiveInteger(timeoutMs, 'Sandbox timeout');
    this.wasmMemoryBytes = requirePositiveInteger(
      options.wasmMemoryBytes ?? DEFAULT_WASM_MEMORY_BYTES,
      'Sandbox WebAssembly memory limit',
    );
    this.workerHeapMegabytes = requirePositiveInteger(
      options.workerHeapMegabytes ?? DEFAULT_WORKER_HEAP_MB,
      'Sandbox worker heap limit',
    );
    this.limiter = new ConcurrencyLimiter(
      options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      options.maxPending ?? DEFAULT_MAX_PENDING,
    );
  }

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
    const prepared = await this.prepare(pluginId);
    const id = randomUUID();
    return await this.limiter.run(() =>
      this.runWorker(
        prepared,
        id,
        { mode: 'numeric', exportName, arguments: [...arguments_] },
        (response) => {
          if (response.resultType !== 'number' && response.resultType !== 'bigint')
            throw new SandboxError('Sandbox returned an invalid scalar result');
          if (typeof response.result !== 'string')
            throw new SandboxError('Sandbox returned an invalid scalar result');
          return response.resultType === 'bigint'
            ? BigInt(response.result)
            : Number(response.result);
        },
      ),
    );
  }

  async invokeJson<T = unknown>(
    pluginId: string,
    exportName: string,
    request: unknown,
  ): Promise<T> {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(exportName))
      throw new SandboxError('Invalid export name');
    const requestJson = JSON.stringify(request);
    if (typeof requestJson !== 'string') throw new SandboxError('Sandbox request is not JSON');
    if (Buffer.byteLength(requestJson) > MAX_REQUEST_BYTES)
      throw new SandboxError('Sandbox request exceeds 1 MiB');
    const prepared = await this.prepare(pluginId);
    const id = randomUUID();
    return await this.limiter.run(async () => {
      const storage = prepared.capabilities.includes('storage.plugin')
        ? this.storageSnapshot(pluginId)
        : null;
      return await this.runWorker<T>(
        prepared,
        id,
        {
          mode: 'json',
          exportName,
          request: {
            apiVersion: 1,
            capabilities: prepared.capabilities,
            host: storage === null ? {} : { storage },
            input: JSON.parse(requestJson) as unknown,
          },
        },
        (response) => this.applyHostResponse(pluginId, prepared.capabilities, response.result) as T,
      );
    });
  }

  private async prepare(pluginId: string): Promise<PreparedSandbox> {
    const row = this.database
      .prepare(
        `SELECT package_path, package_digest, manifest_json FROM plugins
         WHERE id = ? AND enabled = 1 AND runtime = 'sandboxed'`,
      )
      .get(pluginId) as
      { package_path: string; package_digest: string | null; manifest_json: string } | undefined;
    if (!row) throw new SandboxError('Sandboxed plugin is not enabled');
    const manifest = validatePluginManifest(JSON.parse(row.manifest_json) as unknown);
    const unsupported = manifest.permissions.filter(
      (capability) => !(sandboxSupportedCapabilities as readonly string[]).includes(capability),
    );
    if (unsupported.length > 0) {
      throw new SandboxError(
        `Sandbox plugin requests unsupported capabilities: ${unsupported.join(', ')}`,
      );
    }
    const packagePath = await realpath(row.package_path);
    if (row.package_digest && (await packageDigest(packagePath)) !== row.package_digest)
      throw new SandboxError('Plugin package integrity check failed');
    const modulePath = await realpath(join(packagePath, manifest.entrypoint));
    if (modulePath !== packagePath && !modulePath.startsWith(`${packagePath}/`)) {
      throw new SandboxError('Plugin entrypoint escapes its package');
    }
    if (!(await lstat(modulePath)).isFile())
      throw new SandboxError('Plugin entrypoint is unavailable');
    await readSandboxModule(modulePath);
    const capabilities = (
      this.database
        .prepare(
          'SELECT capability FROM plugin_permissions WHERE plugin_id = ? AND requested = 1 AND granted = 1 ORDER BY capability',
        )
        .all(pluginId) as { capability: string }[]
    ).map((permission) => permission.capability);
    if (
      capabilities.some(
        (capability) => !(sandboxSupportedCapabilities as readonly string[]).includes(capability),
      )
    ) {
      throw new SandboxError('Sandbox plugin has an unsupported granted capability');
    }
    return {
      modulePath,
      workerPath: join(dirname(fileURLToPath(import.meta.url)), 'sandbox-worker-process.mjs'),
      capabilities,
    };
  }

  private async runWorker<T>(
    prepared: PreparedSandbox,
    id: string,
    invocation: Record<string, unknown>,
    parseResult: (response: WorkerResponse) => T,
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const child = fork(prepared.workerPath, [], {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: [
          '--permission',
          `--allow-fs-read=${prepared.workerPath}`,
          `--allow-fs-read=${prepared.modulePath}`,
          '--no-addons',
          `--max-old-space-size=${String(this.workerHeapMegabytes)}`,
          '--disable-proto=throw',
        ],
        env: { NODE_ENV: 'production' },
      });
      let settled = false;
      const finish = (error?: Error, result?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        terminateChildProcess(child, true);
        if (error) reject(error);
        else resolve(result as T);
      };
      const timer = setTimeout(() => {
        finish(new SandboxError('Sandbox invocation exceeded its time limit'));
      }, this.timeoutMs);
      child.on('error', (error) => {
        finish(error);
      });
      child.on('exit', (code, signal) => {
        if (!settled) {
          finish(
            new SandboxError(
              code === 0 && signal === null
                ? 'Sandbox returned no result'
                : 'Sandbox process exited unexpectedly',
            ),
          );
        }
      });
      child.on('message', (message: unknown) => {
        if (!isWorkerResponse(message) || message.id !== id) return;
        let encoded: string;
        try {
          encoded = JSON.stringify(message);
        } catch {
          finish(new SandboxError('Sandbox response is not serializable'));
          return;
        }
        if (Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES) {
          finish(new SandboxError('Sandbox response exceeds 1 MiB'));
          return;
        }
        if (message.ok !== true) {
          finish(
            new SandboxError(typeof message.error === 'string' ? message.error : 'Sandbox failed'),
          );
          return;
        }
        try {
          finish(undefined, parseResult(message));
        } catch (error) {
          finish(error instanceof Error ? error : new SandboxError('Invalid sandbox response'));
        }
      });
      child.send(
        {
          id,
          modulePath: prepared.modulePath,
          wasmMemoryBytes: this.wasmMemoryBytes,
          ...invocation,
        },
        (error) => {
          if (error) finish(error);
        },
      );
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
    let effectBytes = 0;
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
          effectBytes += decoded.length;
          if (
            decoded.length > 1024 * 1024 ||
            effectBytes > 4 * 1024 * 1024 ||
            decoded.toString('base64') !== effect.value
          )
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

function isWorkerResponse(value: unknown): value is WorkerResponse {
  return typeof value === 'object' && value !== null;
}

async function readSandboxModule(path: string): Promise<Buffer> {
  const bytes = await readFile(path);
  if (bytes.length > 64 * 1024 * 1024) throw new SandboxError('WebAssembly module exceeds 64 MiB');
  return bytes;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

export class SandboxError extends Error {
  readonly statusCode = 500;
}
