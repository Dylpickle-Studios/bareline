import { describe, expect, it } from 'vitest';
import {
  validateObjectId,
  validateRef,
  validateRepoPath,
  validateSlug,
} from '../src/security/validation.js';

describe('security validation', () => {
  it('accepts deliberately narrow slugs', () => {
    expect(validateSlug('Alice-2', 'username')).toBe('alice-2');
  });

  it.each(['../secret', '/etc/passwd', 'a\\b', '.', 'x\0y', '-option', 'a//b', 'a\nb'])(
    'rejects unsafe repository path %j',
    (path) => {
      expect(() => validateRepoPath(path)).toThrow();
    },
  );

  it.each([
    '-main',
    '../main',
    'main.lock',
    'main~1',
    'main^{tree}',
    'a@{1}',
    'feature/.hidden',
    'feature/topic.lock',
    'feature//topic',
    '@',
  ])('rejects unsafe ref %j', (ref) => {
    expect(() => validateRef(ref)).toThrow();
  });

  it('requires complete SHA-1 or SHA-256 object IDs', () => {
    expect(validateObjectId('a'.repeat(40))).toBe('a'.repeat(40));
    expect(validateObjectId('b'.repeat(64))).toBe('b'.repeat(64));
    expect(() => validateObjectId('deadbeef')).toThrow();
  });
});
