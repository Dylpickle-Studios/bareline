import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.js';

describe('YAML configuration', () => {
  it('ignores environment examples in comments and applies typed overrides', () => {
    const config = loadConfig('config.example.yml', {
      BARELINE_SERVER_PORT: '3456',
      BARELINE_SERVER_PUBLIC_URL: 'https://git.example.test',
    });
    expect(config.server.port).toBe(3456);
    expect(config.server.publicUrl).toBe('https://git.example.test');
    expect(config.mirrors).toMatchObject({
      importTimeoutMs: 300_000,
      maxImportBytes: 10 * 1024 * 1024 * 1024,
      maxImportRefs: 10_000,
    });
  });

  it('ships a container configuration rooted in the persistent volume', () => {
    const config = loadConfig('config.docker.yml', {});
    expect(config.storage.data).toBe('/var/lib/bareline');
    expect(config.storage.repositories).toBe('/var/lib/bareline/repositories');
    expect(config.database.path).toBe('/var/lib/bareline/app.db');
  });
});
