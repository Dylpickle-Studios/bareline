import { describe, expect, it } from 'vitest';
import { ConcurrencyLimiter, ResourceLimitError } from '../src/security/process-limits.js';

describe('process resource limits', () => {
  it('bounds active work and rejects an overflowing queue', async () => {
    const limiter = new ConcurrencyLimiter(1, 1);
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = () => {
        resolve();
      };
    });
    const first = limiter.run(() => blocked);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = limiter.run(() => Promise.resolve());
    await expect(limiter.run(() => Promise.resolve())).rejects.toBeInstanceOf(ResourceLimitError);
    unblock();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(limiter.activeCount).toBe(0);
    expect(limiter.pendingCount).toBe(0);
  });

  it('does not release a slot twice', async () => {
    const limiter = new ConcurrencyLimiter(1, 0);
    const release = await limiter.acquire();
    release();
    release();
    expect(limiter.activeCount).toBe(0);
    await expect(limiter.acquire()).resolves.toBeTypeOf('function');
  });
});
