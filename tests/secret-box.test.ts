import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox } from '../src/security/secret-box.js';

describe('encrypted secret storage', () => {
  it('uses authenticated, context-bound encryption', () => {
    const box = new SecretBox(randomBytes(32).toString('base64url'));
    const encrypted = box.encrypt('sensitive value', 'plugin:example:key');
    expect(encrypted.toString()).not.toContain('sensitive value');
    expect(box.decrypt(encrypted, 'plugin:example:key')).toBe('sensitive value');
    expect(() => box.decrypt(encrypted, 'plugin:other:key')).toThrow();
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
    expect(() => box.decrypt(tampered, 'plugin:example:key')).toThrow();
  });
});
