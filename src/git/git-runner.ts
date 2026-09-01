import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { ConcurrencyLimiter, terminateChildProcess } from '../security/process-limits.js';
import { GitError } from './errors.js';

interface CancellationSource {
  once(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}

export interface ManagedProcessOptions {
  timeoutMs: number;
  onTimeout: () => Error;
  /** Set only when the child was spawned as a detached process-group leader. */
  killProcessGroup?: boolean;
  /**
   * Called exactly once, the moment the process lifecycle ends (from the timeout, a
   * cancellation source, `terminate()`, or a caller-driven `settle()`). Receives the
   * termination error, or `undefined` for a clean settle.
   */
  onSettle: (error: Error | undefined) => void;
}

/**
 * Shared bookkeeping for the spawn/timeout/cancel/kill state machine that every Git-invoking
 * transport (local exec, Smart HTTP, SSH forced-command) otherwise reimplements independently.
 * Callers still wire up their own stdout/stdin handling; this only owns "settle exactly once,
 * clear the timer, and stop listening to cancellation sources."
 */
export class ManagedProcess {
  private settled = false;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly child: ChildProcess,
    private readonly options: ManagedProcessOptions,
  ) {
    this.timer = setTimeout(() => {
      this.terminate(options.onTimeout());
    }, options.timeoutMs);
  }

  /** Terminates the process if `source` emits `event` before the process otherwise settles. */
  cancelOn(source: CancellationSource, event: string, error: Error): void {
    const handler = (): void => {
      this.terminate(error);
    };
    source.once(event, handler);
    this.cleanups.push(() => source.removeListener(event, handler));
  }

  /** Kills the process and settles with `error`. */
  terminate(error: Error): void {
    if (this.settled) return;
    terminateChildProcess(this.child, this.options.killProcessGroup ?? false);
    this.settle(error);
  }

  /** Stops the child without settling, for bounded-prefix/truncation flows. */
  stop(): void {
    terminateChildProcess(this.child, this.options.killProcessGroup ?? false);
  }

  /** Ends the lifecycle without killing the process. Safe to call more than once. */
  settle(error?: Error): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.options.onSettle(error);
  }
}

export interface GitRunOptions {
  cwd?: string;
  input?: Uint8Array;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  acceptedExitCodes?: readonly number[];
  indexFile?: string;
  truncateOutput?: boolean;
  maxInputBytes?: number;
  /** Additional environment variables layered onto the controlled Git environment. */
  env?: Readonly<Record<string, string>>;
}

export interface GitRunnerLimits {
  readonly maxConcurrent?: number;
  readonly maxPending?: number;
  readonly maxInputBytes?: number;
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
  private readonly limiter: ConcurrencyLimiter;
  private readonly maxInputBytes: number;

  constructor(
    private readonly executable: string,
    private readonly defaultTimeoutMs: number,
    private readonly defaultMaxOutputBytes: number,
    limits: GitRunnerLimits = {},
  ) {
    this.limiter = new ConcurrencyLimiter(limits.maxConcurrent ?? 8, limits.maxPending ?? 32);
    this.maxInputBytes = limits.maxInputBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxInputBytes) || this.maxInputBytes <= 0)
      throw new Error('Git input limit must be positive');
  }

  async run(arguments_: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
    if (arguments_.some((argument) => argument.includes('\0')))
      throw new GitError('Invalid Git argument', 'failed');
    const inputLimit = options.maxInputBytes ?? this.maxInputBytes;
    if (!Number.isSafeInteger(inputLimit) || inputLimit <= 0)
      throw new GitError('Invalid Git input limit', 'failed');
    if (options.input && options.input.byteLength > inputLimit)
      throw new GitError('Git input limit exceeded', 'output_limit');
    return await this.limiter.run(() => this.runUnbounded(arguments_, options));
  }

  private async runUnbounded(
    arguments_: readonly string[],
    options: GitRunOptions,
  ): Promise<GitResult> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const maxOutputBytes = options.maxOutputBytes ?? this.defaultMaxOutputBytes;

    return await new Promise<GitResult>((resolve, reject) => {
      const child = spawn(this.executable, [...gitSafetyArguments, ...arguments_], {
        cwd: options.cwd,
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: controlledGitEnvironment({
          ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
          ...options.env,
        }),
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;

      const proc = new ManagedProcess(child, {
        timeoutMs,
        onTimeout: () => new GitError('Git operation exceeded its time limit', 'timeout'),
        killProcessGroup: process.platform !== 'win32',
        onSettle: (error) => {
          if (error) reject(error);
        },
      });
      const { signal } = options;
      if (signal) {
        proc.cancelOn(
          {
            once: (event, listener) => {
              signal.addEventListener(event, listener, { once: true });
            },
            removeListener: (event, listener) => {
              signal.removeEventListener(event, listener);
            },
          },
          'abort',
          new GitError('Git operation cancelled', 'cancelled'),
        );
      }
      const succeed = (result: GitResult): void => {
        proc.settle();
        resolve(result);
      };

      child.on('error', () => {
        proc.settle(new GitError('Unable to start Git', 'failed'));
      });
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          if (options.truncateOutput) {
            const used = stdout.reduce((total, value) => total + value.length, 0);
            stdout.push(chunk.subarray(0, Math.max(0, maxOutputBytes - used)));
            proc.stop();
            succeed({
              stdout: Buffer.concat(stdout),
              stderr: '',
              exitCode: -1,
              truncated: true,
            });
          } else proc.terminate(new GitError('Git output limit exceeded', 'output_limit'));
        } else stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes)
          proc.terminate(new GitError('Git output limit exceeded', 'output_limit'));
        else if (Buffer.concat(stderr).length < 64 * 1024) stderr.push(chunk);
      });
      child.on('close', (code) => {
        const exitCode = code ?? -1;
        const accepted = options.acceptedExitCodes ?? [0];
        const safeStderr = Buffer.concat(stderr).toString('utf8').slice(0, 4096);
        if (!accepted.includes(exitCode)) {
          proc.settle(
            new GitError(
              safeStderr ? `Git operation failed: ${safeStderr}` : 'Git operation failed',
              'failed',
            ),
          );
          return;
        }
        succeed({
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
    const canonicalRoot = await realpath(allowedRoot);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch {
      throw new GitError('Repository does not exist', 'not_found');
    }
    try {
      // Resolve the canonical path from the already-open file descriptor rather than
      // re-reading `path` from disk a second time, so the directory checked against
      // `allowedRoot` is guaranteed to be the exact one just opened: a symlink swapped
      // in between separate path-based syscalls can't smuggle a different target through.
      const canonicalPath = await realpath(`/proc/self/fd/${String(handle.fd)}`);
      if (canonicalPath !== canonicalRoot && !canonicalPath.startsWith(`${canonicalRoot}/`)) {
        throw new GitError('Repository path is outside its storage root', 'not_found');
      }
      return canonicalPath;
    } finally {
      await handle.close();
    }
  }
}
