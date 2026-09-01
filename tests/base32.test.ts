import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode } from '../src/security/base32.js';

describe('base32 (RFC 4648) encoding', () => {
  it('matches the RFC 4648 test vectors', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(Buffer.from(plain, 'utf8'))).toBe(encoded);
      expect(base32Decode(encoded).toString('utf8')).toBe(plain);
    }
  });

  it('round-trips arbitrary binary data and accepts padded or lowercase input', () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = Buffer.from(Array.from({ length }, (_, index) => (index * 37) % 256));
      const encoded = base32Encode(bytes);
      expect(base32Decode(encoded)).toEqual(bytes);
      expect(base32Decode(encoded.toLowerCase())).toEqual(bytes);
      expect(base32Decode(`${encoded}${'='.repeat((8 - (encoded.length % 8)) % 8)}`)).toEqual(
        bytes,
      );
    }
  });

  it('rejects invalid characters', () => {
    expect(() => base32Decode('not-base32!')).toThrow(/Invalid base32/);
  });
});
