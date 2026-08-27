import type { ChildProcess } from 'node:child_process';

/**
 * A bounded FIFO gate for expensive child-process work.
 *
 * The pending bound matters as much as the active bound: without it, an
 * attacker can turn a concurrency limit into an unbounded in-memory queue.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly pending: ((release: () => void) => void)[] = [];

  constructor(
    readonly maxConcurrent: number,
    readonly maxPending = maxConcurrent * 4,
  ) {
    if (!isPositiveInteger(maxConcurrent) || !isNonNegativeInteger(maxPending)) {
      throw new Error('Concurrency limits must be positive integers');
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return this.createRelease();
    }
    if (this.pending.length >= this.maxPending) {
      throw new ResourceLimitError('Resource concurrency limit reached');
    }
    return await new Promise<() => void>((resolve) => {
      this.pending.push(resolve);
    });
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.pending.shift();
      if (next) {
        next(this.createRelease());
      } else {
        this.active -= 1;
      }
    };
  }
}

export class ResourceLimitError extends Error {
  readonly code = 'resource_limit' as const;
  readonly statusCode = 503;
}

/** Shared cap for the streaming Git transports that do not use GitRunner. */
export const gitTransportLimiter = new ConcurrencyLimiter(16, 64);

/**
 * Kill a child and, when the caller created a detached process group, all of
 * its descendants. Negative PIDs are only used for processes explicitly
 * spawned as detached group leaders; using them for arbitrary children could
 * signal an unrelated process group.
 */
export function terminateChildProcess(
  child: Pick<ChildProcess, 'kill' | 'pid'>,
  processGroup = false,
): void {
  if (processGroup && process.platform !== 'win32' && child.pid !== undefined && child.pid > 0) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch (error) {
      if (!isErrno(error, 'ESRCH')) {
        // Fall through to the direct child as a best-effort cleanup.
      }
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // The child may have exited between the lifecycle check and the kill.
  }
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
