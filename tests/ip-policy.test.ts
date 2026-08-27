import { describe, expect, it } from 'vitest';
import { isAddressAllowed } from '../src/security/ip-policy.js';

describe('IP allowlist matching', () => {
  it('matches IPv4 and IPv6 CIDRs without matching neighboring ranges', () => {
    expect(isAddressAllowed('192.0.2.42', ['192.0.2.0/24'])).toBe(true);
    expect(isAddressAllowed('192.0.3.42', ['192.0.2.0/24'])).toBe(false);
    expect(isAddressAllowed('2001:db8:1234::42', ['2001:db8:1234::/48'])).toBe(true);
    expect(isAddressAllowed('2001:db8:1235::42', ['2001:db8:1234::/48'])).toBe(false);
  });

  it('supports compressed IPv6 and embedded IPv4 addresses', () => {
    expect(isAddressAllowed('::1', ['::1'])).toBe(true);
    expect(isAddressAllowed('::ffff:192.0.2.7', ['::ffff:192.0.2.0/120'])).toBe(true);
    expect(isAddressAllowed('::ffff:192.0.3.7', ['::ffff:192.0.2.0/120'])).toBe(false);
  });
});
