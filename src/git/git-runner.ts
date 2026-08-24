import { spawn } from 'node:child_process';
import { open, realpath, stat } from 'node:fs/promises';
import { GitError } from './errors.js';

export interface GitRunOptions {
  cwd?: string;
  input?: Uint8Array;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  acceptedExitCodes?: readonly number[];
  indexFile?: string;
  truncateOutput?: boolean;
}

export interface GitResult {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly exitCode: number;
  readonly truncated: boolean;
}

const controlledPath = '/usr/local/bin:/usr/bin:/bin';

export const gitSafetyArguments = Object.freeze([
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'diff.external=',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'protocol.file.allow=never',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'gpg.program=gpg',
  '-c',
  'gpg.openpgp.program=gpg',
  '-c',
  'gpg.ssh.program=ssh-keygen',
  '-c',
  'gpg.x509.program=gpgsm',
]);

export function controlledGitEnvironment(
  additions: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  return {
    HOME: '/nonexistent',
    PATH: controlledPath,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PROTOCOL_FROM_USER: '0',
    ...additions,
  };
}

export class GitRunner {
  constructor(
    private readonly executable: string,
    private readonly defaultTimeoutMs: number,
    private readonly defaultMaxOutputBytes: number,
  ) {}

  async run(arguments_: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
    if (arguments_.some((argument) => argument.includes('\0')))
      throw new GitError('Invalid Git argument', 'failed');
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const maxOutputBytes = options.maxOutputBytes ?? this.defaultMaxOutputBytes;

    return await new Promise<GitResult>((resolve, reject) => {
      const child = spawn(this.executable, [...gitSafetyArguments, ...arguments_], {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: controlledGitEnvironment(
          options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {},
        ),
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const finish = (error?: Error, result?: GitResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else if (result) resolve(result);
        else reject(new GitError('Git operation ended without a result', 'failed'));
      };
      const terminate = (error: GitError): void => {
        child.kill('SIGKILL');
        finish(error);
      };
      const abort = (): void => {
        terminate(new GitError('Git operation cancelled', 'cancelled'));
      };
      const timer = setTimeout(() => {
        terminate(new GitError('Git operation exceeded its time limit', 'timeout'));
      }, timeoutMs);

      options.signal?.addEventListener('abort', abort, { once: true });
      child.on('error', () => {
        finish(new GitError('Unable to start Git', 'failed'));
      });
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          if (options.truncateOutput) {
            const used = stdout.reduce((total, value) => total + value.length, 0);
            stdout.push(chunk.subarray(0, Math.max(0, maxOutputBytes - used)));
            child.kill('SIGKILL');
            finish(undefined, {
              stdout: Buffer.concat(stdout),
              stderr: '',
              exitCode: -1,
              truncated: true,
            });
          } else terminate(new GitError('Git output limit exceeded', 'output_limit'));
        } else stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes)
          terminate(new GitError('Git output limit exceeded', 'output_limit'));
        else if (Buffer.concat(stderr).length < 64 * 1024) stderr.push(chunk);
      });
      child.on('close', (code) => {
        const exitCode = code ?? -1;
        const accepted = options.acceptedExitCodes ?? [0];
        const safeStderr = Buffer.concat(stderr).toString('utf8').slice(0, 4096);
        if (!accepted.includes(exitCode)) {
          finish(
            new GitError(
              safeStderr ? `Git operation failed: ${safeStderr}` : 'Git operation failed',
              'failed',
            ),
          );
          return;
        }
        finish(undefined, {
          stdout: Buffer.concat(stdout),
          stderr: safeStderr,
          exitCode,
          truncated: false,
        });
      });

      if (options.input) child.stdin.end(options.input);
      else child.stdin.end();
    });
  }

  async assertRepository(path: string, allowedRoot: string): Promise<string> {
    const [canonicalPath, canonicalRoot] = await Promise.all([
      realpath(path),
      realpath(allowedRoot),
    ]);
    if (canonicalPath !== canonicalRoot && !canonicalPath.startsWith(`${canonicalRoot}/`)) {
      throw new GitError('Repository path is outside its storage root', 'not_found');
    }
    const info = await stat(canonicalPath);
    if (!info.isDirectory()) throw new GitError('Repository does not exist', 'not_found');
    const handle = await open(canonicalPath, 'r');
    await handle.close();
    return canonicalPath;
  }
}
