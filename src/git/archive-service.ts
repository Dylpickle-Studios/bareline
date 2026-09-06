import { pipeline } from 'node:stream/promises';
import {
  ConcurrencyLimiter,
  gitTransportLimiter,
  terminateChildProcess,
} from '../security/process-limits.js';
import { spawn } from 'node:child_process';
import { PassThrough, Transform, type TransformCallback } from 'node:stream';
import { createGzip } from 'node:zlib';
import type { AppConfig } from '../config/config.js';
import type { RepositoryService } from '../repositories/repository-service.js';
import type { Repository } from '../repositories/repository-types.js';
import { controlledGitEnvironment, gitSafetyArguments } from './git-runner.js';

export type ArchiveFormat = 'zip' | 'tar.gz';

export class ArchiveService {
  constructor(
    private readonly config: AppConfig,
    private readonly repositories: RepositoryService,
    private readonly limiter: ConcurrencyLimiter = gitTransportLimiter,
  ) {}

  async create(repository: Repository, ref: string, format: ArchiveFormat) {
    const objectId = await this.repositories.resolveCommit(repository, ref);
    const repositoryPath = await this.repositories.storagePath(repository);
    const release = await this.limiter.acquire();
    let child;
    try {
      child = spawn(
        this.config.git.executable,
        [
          ...gitSafetyArguments,
          '--git-dir',
          repositoryPath,
          'archive',
          `--format=${format === 'zip' ? 'zip' : 'tar'}`,
          `--prefix=${repository.slug}-${objectId.slice(0, 8)}/`,
          objectId,
        ],
        {
          shell: false,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: controlledGitEnvironment(),
        },
      );
    } catch (error) {
      release();
      throw error;
    }
    const archiveChild = child;
    const output = new PassThrough();
    let childClosed = false;
    let streamClosed = false;
    const maybeRelease = () => {
      if (childClosed && streamClosed) {
        clearTimeout(timer);
        release();
      }
    };
    const limiter = new ByteLimitTransform(this.config.limits.archiveBytes);
    const timer = setTimeout(
      () => {
        terminateChildProcess(archiveChild, process.platform !== 'win32');
        output.destroy(new Error('Archive generation timed out'));
      },
      Math.max(this.config.git.timeoutMs, 120_000),
    );
    child.on('error', (error) => output.destroy(error));
    child.stderr.resume();
    child.on('close', (code) => {
      childClosed = true;
      maybeRelease();
      if (code !== 0) output.destroy(new Error('Archive generation failed'));
    });
    const streams =
      format === 'tar.gz'
        ? [child.stdout, createGzip({ level: 6 }), limiter, output]
        : [child.stdout, limiter, output];
    void pipeline(streams).catch((error: unknown) => {
      terminateChildProcess(archiveChild, process.platform !== 'win32');
      output.destroy(error instanceof Error ? error : new Error('Archive stream failed'));
    });
    output.on('close', () => {
      streamClosed = true;
      if (!childClosed) terminateChildProcess(archiveChild, process.platform !== 'win32');
      maybeRelease();
    });
    return {
      stream: output,
      objectId,
      contentType: format === 'zip' ? 'application/zip' : 'application/gzip',
      extension: format,
    };
  }
}

class ByteLimitTransform extends Transform {
  private bytes = 0;

  constructor(private readonly limit: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) callback(new Error('Archive exceeded configured size limit'));
    else callback(null, chunk);
  }
}
