import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { request } from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboundPolicy } from '../src/security/outbound-policy.js';

vi.mock('node:https', () => ({ request: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe('pinned outbound connections', () => {
  it('connects HTTP to the approved address, preserving TLS and Host identity without a third lookup', async () => {
    let lookups = 0;
    const policy = new OutboundPolicy(() =>
      Promise.resolve([
        { address: ++lookups <= 2 ? '93.184.216.34' : '127.0.0.1', family: 4 as const },
      ]),
    );
    const url = await policy.assertSafeUrl('https://public.example/events?x=1', {
      allowedHosts: ['public.example'],
    });
    vi.mocked(request).mockImplementation(((
      options: unknown,
      callback: (response: unknown) => void,
    ) => {
      expect(options).toMatchObject({
        hostname: '93.184.216.34',
        servername: 'public.example',
        rejectUnauthorized: true,
        agent: false,
        headers: { host: 'public.example' },
        path: '/events?x=1',
      });
      const client = Object.assign(new EventEmitter(), {
        end: () => {
          const response = Object.assign(new PassThrough(), { statusCode: 204 });
          callback(response);
          response.end();
        },
      });
      return client;
    }) as unknown as typeof request);
    await expect(policy.post(url, { body: '{}', headers: {}, timeoutMs: 1000 })).resolves.toEqual({
      ok: true,
      status: 204,
    });
    expect(lookups).toBe(2);
    expect(policy.gitArguments(url)).toContain(
      'http.curloptResolve=public.example:443:93.184.216.34',
    );
    url.hostname = 'other.example';
    expect(() => policy.httpsOptions(url)).toThrow(/pin/);
    expect(() => policy.gitArguments(new URL('https://public.example'))).toThrow(/pin/);
  });

  it('pins IPv6 HTTPS and SSH destinations without changing the authenticated hostname', async () => {
    const policy = new OutboundPolicy(() =>
      Promise.resolve([{ address: '2001:4860:4860::8888', family: 6 as const }]),
    );
    const rules = { allowedHosts: ['public.example'] };
    const https = await policy.prepareGitTarget('https://public.example/repo.git', rules);
    expect(https.arguments).toContain(
      'http.curloptResolve=public.example:443:[2001:4860:4860::8888]',
    );
    const ssh = await policy.prepareGitTarget('git@public.example:org/repo.git', rules);
    expect(ssh.env.GIT_SSH_COMMAND).toContain('HostName=2001:4860:4860::8888');
    expect(ssh.env.GIT_SSH_COMMAND).toContain('HostKeyAlias=public.example');
    expect(ssh.env.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=yes');
  });

  it('does not follow redirects and bounds response bodies', async () => {
    const policy = new OutboundPolicy(() =>
      Promise.resolve([{ address: '93.184.216.34', family: 4 as const }]),
    );
    const url = await policy.assertSafeUrl('https://public.example', {
      allowedHosts: ['public.example'],
    });
    let oversized = false;
    vi.mocked(request).mockImplementation(((
      _options: unknown,
      callback: (response: unknown) => void,
    ) =>
      Object.assign(new EventEmitter(), {
        end: () => {
          const response = Object.assign(new PassThrough(), {
            statusCode: oversized ? 200 : 302,
            headers: { location: 'https://127.0.0.1/' },
          });
          callback(response);
          response.end(Buffer.alloc(oversized ? 65_537 : 0));
        },
      })) as unknown as typeof request);
    expect(await policy.post(url, { body: '', headers: {}, timeoutMs: 1000 })).toEqual({
      ok: false,
      status: 302,
    });
    expect(request).toHaveBeenCalledTimes(1);
    oversized = true;
    await expect(policy.post(url, { body: '', headers: {}, timeoutMs: 1000 })).rejects.toThrow(
      /limit/,
    );
  });
});
