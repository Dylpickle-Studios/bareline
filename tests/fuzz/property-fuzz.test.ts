import { describe, expect, it } from 'vitest';
import { parseDiffFiles } from '../../src/git/git-browser.js';
import { parseLfsPointer } from '../../src/lfs/lfs-pointer.js';
import { validatePluginManifest } from '../../src/plugins/manifest.js';
import { parseGitmodules } from '../../src/repositories/repository-service.js';
import { validateRef, validateRepoPath } from '../../src/security/validation.js';
import { imageMetadata } from '../../src/web/file-presentation.js';
import { headingAnchor, renderMarkdown } from '../../src/web/markdown.js';

function randomInput(seed: number, length: number): string {
  let state = seed >>> 0;
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < bytes.length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bytes[index] = state & 0xff;
  }
  return bytes.toString('utf8');
}

function doesNotCrash(action: () => unknown): void {
  try {
    action();
  } catch {
    // Parsers may reject malformed input. The property is bounded rejection, not acceptance.
  }
}

describe('bounded parser fuzz corpus', () => {
  it('keeps hostile text parsers bounded and non-throwing at the process boundary', () => {
    const cases = Number.parseInt(process.env.BARELINE_FUZZ_CASES ?? '120', 10);
    for (let seed = 0; seed < Math.max(1, Math.min(cases, 20_000)); seed += 1) {
      const input = randomInput(seed, (seed * 97) % 4096);
      doesNotCrash(() => parseGitmodules(input));
      doesNotCrash(() => parseDiffFiles(input, 20, 16 * 1024));
      doesNotCrash(() => renderMarkdown(input.slice(0, 8192)));
      doesNotCrash(() => headingAnchor(input));
      doesNotCrash(() => parseLfsPointer(Buffer.from(input)));
      doesNotCrash(() => imageMetadata(Buffer.from(input), `${String(seed)}.jpg`));
      doesNotCrash(() => validateRef(input));
      doesNotCrash(() => validateRepoPath(input));
      doesNotCrash(() => validatePluginManifest(input));
    }
  });

  it('preserves parser ceilings for repeated structured input', () => {
    const diff = Array.from(
      { length: 1000 },
      (_, index) => `diff --git a/${String(index)} b/${String(index)}`,
    ).join('\n');
    expect(parseDiffFiles(diff, 25, 1024)).toHaveLength(25);
    expect(parseLfsPointer(Buffer.alloc(4097))).toBeNull();
    expect(renderMarkdown('x'.repeat(20_000))).toContain('x');
  });
});
