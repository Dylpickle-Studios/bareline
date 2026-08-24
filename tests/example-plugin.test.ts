import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { examplePluginArchive } from '../src/plugins/example-download.js';

describe('example plugin package', () => {
  it('builds a bounded tar archive containing the documented package', async () => {
    const archive = await examplePluginArchive();
    expect(archive.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    const tar = gunzipSync(archive);
    expect(tar.toString('utf8')).toContain('repository-word-count/plugin.yml');
    expect(tar.toString('utf8')).toContain('example.word-count');
    expect(tar.length).toBeLessThan(100_000);
  });
});
