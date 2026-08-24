import { describe, expect, it } from 'vitest';
import { GitRunner } from '../src/git/git-runner.js';

describe('Git runner output protection', () => {
  it('returns an explicitly marked bounded prefix only when truncation is requested', async () => {
    const runner = new GitRunner('git', 5000, 1024);
    const result = await runner.run(['help', '-a'], { maxOutputBytes: 128, truncateOutput: true });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(128);
  });

  it('fails closed by default when output exceeds the limit', async () => {
    const runner = new GitRunner('git', 5000, 1024);
    await expect(runner.run(['help', '-a'], { maxOutputBytes: 128 })).rejects.toThrow(
      /output limit/,
    );
  });

  it('overrides hook, protocol, and signature helpers with controlled values', async () => {
    const runner = new GitRunner('git', 5000, 4096);
    await expect(runner.run(['config', '--get', 'core.hooksPath'])).resolves.toMatchObject({
      stdout: Buffer.from('/dev/null\n'),
    });
    await expect(runner.run(['config', '--get', 'gpg.program'])).resolves.toMatchObject({
      stdout: Buffer.from('gpg\n'),
    });
    await expect(runner.run(['config', '--get', 'protocol.ext.allow'])).resolves.toMatchObject({
      stdout: Buffer.from('never\n'),
    });
  });
});
