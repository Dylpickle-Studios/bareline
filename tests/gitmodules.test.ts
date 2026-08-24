import { describe, expect, it } from 'vitest';
import { parseGitmodules } from '../src/repositories/repository-service.js';

describe('.gitmodules presentation', () => {
  it('extracts paths and URLs without executing or fetching them', () => {
    const modules = parseGitmodules(`[submodule "safe"]
  path = vendor/safe
  url = https://example.test/safe.git
[submodule "hostile"]
  path = ../../escape
  url = ssh://example.test/escape.git`);
    expect(modules.get('vendor/safe')).toBe('https://example.test/safe.git');
    expect(modules.has('../../escape')).toBe(false);
  });

  it('bounds oversized configuration', () => {
    expect(parseGitmodules('x'.repeat(1024 * 1024 + 1)).size).toBe(0);
  });
});
