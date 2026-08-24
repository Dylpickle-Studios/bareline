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
  ) {}

  async create(repository: Repository, ref: string, format: ArchiveFormat) {
    const objectId = await this.repositories.resolveCommit(repository, ref);
    const repositoryPath = await this.repositories.storagePath(repository);
    const child = spawn(
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
        stdio: ['ignore', 'pipe', 'pipe'],
        env: controlledGitEnvironment(),
      },
    );
    const output = new PassThrough();
    const limiter = new ByteLimitTransform(this.config.limits.archiveBytes);
    const timer = setTimeout(
      () => child.kill('SIGKILL'),
      Math.max(this.config.git.timeoutMs, 120_000),
    );
    child.on('error', (error) => output.destroy(error));
    child.stderr.resume();
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) output.destroy(new Error('Archive generation failed'));
    });
    const source = format === 'tar.gz' ? child.stdout.pipe(createGzip({ level: 6 })) : child.stdout;
    source.pipe(limiter).pipe(output);
    output.on('close', () => {
      if (!child.killed) child.kill('SIGKILL');
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
