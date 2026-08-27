import { describe, expect, it } from 'vitest';
import {
  OutboundPolicy,
  OutboundPolicyError,
  isNonPublicAddress,
  type ResolvedAddress,
} from '../src/security/outbound-policy.js';

const rules = { allowedHosts: ['public.example.test'], protocols: ['https:'], ports: [443] };

function resolver(
  addresses: readonly string[],
): (hostname: string) => Promise<readonly ResolvedAddress[]> {
  return () =>
    Promise.resolve(
      addresses.map((address) => ({
        address,
        family: address.includes(':') ? 6 : 4,
      })),
    );
}

describe('outbound policy', () => {
  it('rejects private, link-local, metadata, and reserved address ranges', () => {
    for (const address of [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '192.0.2.1',
      '198.18.0.1',
      '203.0.113.1',
      '224.0.0.1',
      '::1',
      'fc00::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isNonPublicAddress(address), address).toBe(true);
    }
    expect(isNonPublicAddress('93.184.216.34')).toBe(false);
    expect(isNonPublicAddress('2001:4860:4860::8888')).toBe(false);
  });

  it('enforces scheme, port, credentials, and exact host allowlists before resolving', async () => {
    const policy = new OutboundPolicy(resolver(['93.184.216.34']));
    await expect(policy.assertSafeUrl('http://public.example.test/', rules)).rejects.toThrow(
      'scheme',
    );
    await expect(policy.assertSafeUrl('https://public.example.test:8443/', rules)).rejects.toThrow(
      'port',
    );
    await expect(
      policy.assertSafeUrl('https://user:secret@public.example.test/', rules),
    ).rejects.toThrow('credentials');
    await expect(policy.assertSafeUrl('https://other.example.test/', rules)).rejects.toThrow(
      'allowlisted',
    );
    await expect(
      policy.assertSafeUrl('https://public.example.test/', rules),
    ).resolves.toBeInstanceOf(URL);
  });

  it('rejects a DNS answer that resolves to a blocked destination', async () => {
    const policy = new OutboundPolicy(resolver(['93.184.216.34', '169.254.169.254']));
    await expect(policy.assertSafeUrl('https://public.example.test/', rules)).rejects.toThrow(
      'private or reserved',
    );
  });

  it('detects a resolver changing from a public answer to a private answer', async () => {
    let calls = 0;
    const policy = new OutboundPolicy(() => {
      calls += 1;
      return Promise.resolve([
        {
          address: calls === 1 ? '93.184.216.34' : '10.0.0.1',
          family: 4 as const,
        },
      ]);
    });
    await expect(policy.assertSafeUrl('https://public.example.test/', rules)).rejects.toThrow(
      'private or reserved',
    );
    expect(calls).toBe(2);
  });

  it('validates SSH Git targets with the same host and address policy', async () => {
    const policy = new OutboundPolicy((hostname) =>
      Promise.resolve(
        hostname.startsWith('private')
          ? [{ address: '10.0.0.1', family: 4 as const }]
          : [{ address: '93.184.216.34', family: 4 as const }],
      ),
    );
    await expect(
      policy.assertSafeGitTarget('git@public.example.test:org/plugin.git', {
        allowedHosts: ['PUBLIC.EXAMPLE.TEST.'],
      }),
    ).resolves.toBe('git@public.example.test:org/plugin.git');
    await expect(
      policy.assertSafeGitTarget('git@private.example.test:org/plugin.git', {
        allowedHosts: ['private.example.test'],
      }),
    ).rejects.toThrow(OutboundPolicyError);
  });
});
