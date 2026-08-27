import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { openDatabase } from '../src/database/database.js';
import { PluginManager } from '../src/plugins/plugin-manager.js';
import { SandboxRuntime } from '../src/plugins/sandbox-runtime.js';
import { temporaryConfig } from './helpers.js';

const returnsFortyTwo = Buffer.from(
  '0061736d010000000105016000017f030201000707010372756e00000a06010400412a0b',
  'hex',
);

function structuredEchoModule(): Buffer {
  const unsigned = (value: number): number[] => {
    const output: number[] = [];
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value !== 0) byte |= 0x80;
      output.push(byte);
    } while (value !== 0);
    return output;
  };
  const name = (value: string) => {
    const bytes = [...Buffer.from(value)];
    return [...unsigned(bytes.length), ...bytes];
  };
  const section = (id: number, value: number[]) => [id, ...unsigned(value.length), ...value];
  const type = [2, 0x60, 1, 0x7f, 1, 0x7f, 0x60, 2, 0x7f, 0x7f, 1, 0x7e];
  const functions = [2, 0, 1];
  const memory = [1, 1, 1, 16];
  const exports = [
    3,
    ...name('memory'),
    2,
    0,
    ...name('plugin_alloc'),
    0,
    0,
    ...name('handle'),
    0,
    1,
  ];
  const allocate = [0, 0x41, ...unsigned(1024), 0x0b];
  const handle = [0, 0x20, 0, 0xad, 0x42, 32, 0x86, 0x20, 1, 0xad, 0x84, 0x0b];
  const code = [
    2,
    ...unsigned(allocate.length),
    ...allocate,
    ...unsigned(handle.length),
    ...handle,
  ];
  return Buffer.from([
    0,
    0x61,
    0x73,
    0x6d,
    1,
    0,
    0,
    0,
    ...section(1, type),
    ...section(3, functions),
    ...section(5, memory),
    ...section(7, exports),
    ...section(10, code),
  ]);
}

describe('sandboxed plugin runtime', () => {
  it('runs import-free WebAssembly in a disposable memory-limited process', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const admin = await new AuthService(database, config, audit).register({
      username: 'admin-user',
      displayName: 'Admin',
      password: 'correct horse battery staple',
    });
    const source = await mkdtemp(join(tmpdir(), 'focused-git-sandbox-'));
    await writeFile(join(source, 'plugin.wasm'), returnsFortyTwo);
    await writeFile(
      join(source, 'plugin.yml'),
      `id: example.answer
name: Answer
version: 1.0.0
apiVersion: 1
runtime: sandboxed
entrypoint: plugin.wasm
`,
      'utf8',
    );
    const manager = new PluginManager(database, config, audit);
    await manager.installLocal(admin.id, source, { trustedRiskAccepted: false });
    manager.setEnabled(admin.id, 'example.answer', true, false);
    await expect(new SandboxRuntime(database).invoke('example.answer', 'run', [])).resolves.toBe(
      42,
    );
    await writeFile(
      join(config.storage.data, 'plugins', 'example.answer', '1.0.0', 'plugin.wasm'),
      Buffer.concat([returnsFortyTwo, Buffer.from([0])]),
    );
    await expect(new SandboxRuntime(database).invoke('example.answer', 'run', [])).rejects.toThrow(
      /integrity/,
    );
    database.close();
  });

  it('passes bounded structured context and only granted capabilities through linear memory', async () => {
    const config = temporaryConfig();
    const database = openDatabase(config.database.path);
    const audit = new AuditService(database);
    const admin = await new AuthService(database, config, audit).register({
      username: 'admin-user',
      displayName: 'Admin',
      password: 'correct horse battery staple',
    });
    const source = await mkdtemp(join(tmpdir(), 'focused-git-structured-sandbox-'));
    await writeFile(join(source, 'plugin.wasm'), structuredEchoModule());
    await writeFile(
      join(source, 'plugin.yml'),
      `id: example.structured
name: Structured
version: 1.0.0
apiVersion: 1
runtime: sandboxed
entrypoint: plugin.wasm
permissions: [repositories.read]
`,
      'utf8',
    );
    const manager = new PluginManager(database, config, audit);
    await manager.installLocal(admin.id, source, { trustedRiskAccepted: false });
    manager.setPermission(admin.id, 'example.structured', 'repositories.read', true);
    manager.setEnabled(admin.id, 'example.structured', true, false);
    await expect(
      new SandboxRuntime(database, 2000, { wasmMemoryBytes: 64 * 1024 }).invokeJson(
        'example.structured',
        'handle',
        { repository: 'alice/example' },
      ),
    ).rejects.toThrow(/linear memory exceeds its limit/);
    const response = await new SandboxRuntime(database).invokeJson<{
      apiVersion: number;
      capabilities: string[];
      host: Record<string, unknown>;
      input: { repository: string };
    }>('example.structured', 'handle', { repository: 'alice/example' });
    expect(response).toEqual({
      apiVersion: 1,
      capabilities: ['repositories.read'],
      host: {},
      input: { repository: 'alice/example' },
    });
    database.close();
  });
});
