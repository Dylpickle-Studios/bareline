import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveService } from '../src/git/archive-service.js';
import { serveSmartHttp } from '../src/http-git/smart-http.js';
import { ConcurrencyLimiter } from '../src/security/process-limits.js';
import type { RepositoryService } from '../src/repositories/repository-service.js';
import type { Repository } from '../src/repositories/repository-types.js';
import { temporaryConfig } from './helpers.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
afterEach(() => vi.resetAllMocks());
function childProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit('close', 137));
      return true;
    }),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

describe('streaming resource boundaries', () => {
  it('holds the archive permit until the output closes and frees it on disconnect and spawn failure', async () => {
    const config = temporaryConfig();
    const limiter = new ConcurrencyLimiter(1, 0);
    const repositories = {
      resolveCommit: () => Promise.resolve('a'.repeat(40)),
      storagePath: () => Promise.resolve('/tmp/test.git'),
    } as unknown as RepositoryService;
    const repository = { slug: 'test' } as Repository;
    const archives = new ArchiveService(config, repositories, limiter);
    const child = childProcess();
    const first = await archives.create(repository, 'main', 'zip');
    first.stream.on('error', () => undefined);
    await expect(archives.create(repository, 'main', 'zip')).rejects.toThrow(/concurrency/);
    expect(spawn).toHaveBeenCalledTimes(1);
    const closed = once(first.stream, 'close');
    first.stream.destroy();
    await closed;
    await vi.waitFor(() => {
      expect(limiter.activeCount).toBe(0);
    });
    expect(child.kill).toHaveBeenCalled();
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });
    await expect(archives.create(repository, 'main', 'zip')).rejects.toThrow('spawn failed');
    expect(limiter.activeCount).toBe(0);
  });

  it('bounds the response queue for a slow Git client and accepts headers coalesced with a large body', async () => {
    const child = childProcess();
    let releaseWrite: (() => void) | undefined;
    let stalled = true;
    const chunks: Buffer[] = [];
    const raw = Object.assign(
      new Writable({
        highWaterMark: 1024,
        write(chunk: Buffer, _encoding, done) {
          chunks.push(chunk);
          if (stalled) releaseWrite = done;
          else done();
        },
      }),
      { writeHead: vi.fn() },
    );
    const reply = { raw, hijack: vi.fn() } as unknown as FastifyReply;
    const completion = serveSmartHttp(
      temporaryConfig(),
      '/tmp/test.git',
      { method: 'GET', pathSuffix: 'info/refs', queryService: 'git-upload-pack' },
      reply,
    );
    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalled();
    });
    const body = Buffer.alloc(64 * 1024, 1);
    child.stdout.write(
      Buffer.concat([
        Buffer.from('Content-Type: application/x-git-upload-pack-advertisement\r\n\r\n'),
        body,
      ]),
    );
    expect(raw.writeHead).toHaveBeenCalled();
    expect(child.stdout.isPaused()).toBe(true);
    for (let index = 0; index < 8; index++) child.stdout.write(body);
    expect(raw.writableLength).toBeLessThanOrEqual(body.length);
    stalled = false;
    releaseWrite?.();
    child.stdout.once('end', () => child.emit('close', 0));
    child.stdout.end();
    await completion;
    expect(Buffer.concat(chunks)).toHaveLength(9 * body.length);
  });
});
