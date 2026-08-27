import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.js';

async function configFile(overrides = ''): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bareline-config-hardening-'));
  const data = join(root, 'data');
  const topLevelKeys = new Set(
    overrides
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith(' '))
      .map((line) => line.replace(/:.*/, '')),
  );
  const content = [
    'server:',
    '  host: 127.0.0.1',
    '  port: 3000',
    '  publicUrl: http://localhost:3000',
    '  tls:',
    '    mode: http',
    ...(topLevelKeys.has('storage')
      ? []
      : [
          'storage:',
          '  data: ' + data,
          '  repositories: ' + join(data, 'repositories'),
          '  trash: ' + join(data, 'trash'),
          '  lfs: ' + join(data, 'lfs'),
          '  importRoots: []',
        ]),
    'database:',
    '  path: ' + join(data, 'app.db'),
    'git:',
    '  executable: git',
    'ssh:',
    '  enabled: false',
    '  host: localhost',
    'registration:',
    '  mode: closed',
    'anonymous:',
    '  publicRepositories: true',
    ...(topLevelKeys.has('limits') ? [] : ['limits: {}']),
    ...(topLevelKeys.has('security') ? [] : ['security: {}']),
    overrides,
  ].join('\n');
  const file = join(root, 'config.yml');
  await writeFile(file, content + '\n', 'utf8');
  return file;
}

describe('safe configuration validation', () => {
  it('rejects unknown keys at every configuration level', async () => {
    const file = await configFile('limits:\n  unknownLimit: 1\n');
    expect(() => loadConfig(file, {})).toThrow('Unrecognized');
  });

  it('requires an exact unpadded base64url 32-byte master key', async () => {
    const invalid = await configFile('security:\n  masterKey: too-short\n');
    expect(() => loadConfig(invalid, {})).toThrow('masterKey');

    const valid = await configFile(
      'security:\n  masterKey: ' + randomBytes(32).toString('base64url') + '\n',
    );
    expect(loadConfig(valid, {}).security.masterKey).toHaveLength(43);
  });

  it('rejects unsafe storage and import-root overlaps', async () => {
    const outside = await configFile(
      'storage:\n  data: /tmp/bareline-config-data\n  repositories: /tmp/outside-repositories\n  trash: /tmp/bareline-config-data/trash\n  lfs: /tmp/bareline-config-data/lfs\n  importRoots: []\n',
    );
    expect(() => loadConfig(outside, {})).toThrow('below storage.data');

    const overlap = await configFile(
      'storage:\n  data: /tmp/bareline-config-data\n  repositories: /tmp/bareline-config-data/repositories\n  trash: /tmp/bareline-config-data/trash\n  lfs: /tmp/bareline-config-data/lfs\n  importRoots: [/tmp]\n',
    );
    expect(() => loadConfig(overlap, {})).toThrow('managed storage directory');
  });

  it('requires proxy trust addresses to be literal IPs or CIDRs', async () => {
    const file = await configFile(
      'authentication:\n  reverseProxy:\n    enabled: true\n    allowedAddresses: [proxy.internal]\n',
    );
    expect(() => loadConfig(file, {})).toThrow('IP address or CIDR');
  });

  it('enforces HTTPS in production and rejects non-finite typed environment overrides', async () => {
    const file = await configFile();
    expect(() => loadConfig(file, { NODE_ENV: 'production' })).toThrow('HTTPS public URL');
    expect(() => loadConfig(file, { BARELINE_SERVER_PORT: 'Infinity' })).toThrow('Invalid integer');
    expect(() => loadConfig(file, { BARELINE_SERVER_PORT: 'not-a-number' })).toThrow(
      'Invalid integer',
    );
  });
});
