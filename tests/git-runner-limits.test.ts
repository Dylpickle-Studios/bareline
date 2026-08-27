import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('rejects oversized stdin before spawning Git', async () => {
    const runner = new GitRunner('git', 5000, 4096, { maxInputBytes: 4 });
    await expect(
      runner.run(['hash-object', '--stdin'], { input: Buffer.from('12345') }),
    ).rejects.toThrow(/input limit/);
  });

  it('bounds concurrent Git children and pending work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'focused-git-runner-'));
    const executable = join(root, 'fake-git');
    await writeFile(executable, '#!/bin/sh\nsleep 0.2\n', 'utf8');
    await chmod(executable, 0o755);
    const runner = new GitRunner(executable, 5000, 4096, {
      maxConcurrent: 1,
      maxPending: 0,
    });
    const first = runner.run([]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(runner.run([])).rejects.toThrow(/concurrency limit/);
    await expect(first).resolves.toMatchObject({ exitCode: 0 });
  });
});
